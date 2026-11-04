namespace Arch.CadConnect.Core.Workspace;

/// <summary>
/// A single remembered "checked-out workspace file" so Undo Checkout stays
/// reachable from the ribbon AFTER the user closes the document (the P4C
/// safety rule refuses byte replacement while a document is open, so the
/// close-then-undo path must exist).
///
/// It is a snapshot of an EXACT workspace-manifest checkout binding - stable
/// identities only, NEVER a filename. Before Undo actually runs, the
/// orchestrator still re-checks everything against the manifest and the
/// authoritative server checkout; this record only keeps the ribbon command
/// enabled and lets the confirmation dialog name the exact target.
/// </summary>
public sealed record RememberedCheckoutTarget(
    ManagedFileRef File,
    string CadDocumentId,
    string CheckoutId,
    string BaseFileVersionId,
    string DocumentNumber)
{
    /// <summary>
    /// True only when this remembered target is STILL an exact, currently
    /// checked-out manifest binding in the CURRENT workspace - same
    /// cadDocumentId, same checkoutId, same base FileVersion. Any drift ->
    /// false, and the caller must forget it.
    /// </summary>
    public bool IsStillUndoable(WorkspaceManifestEntry? currentEntry, string? currentWorkspaceRoot)
    {
        if (currentEntry?.Checkout is not { } checkout)
        {
            return false; // entry gone, or the local checkout marker was cleared
        }
        if (!RootsEqual(File.WorkspaceRoot, currentWorkspaceRoot))
        {
            return false; // the workspace changed - this target belongs to a different root
        }
        return string.Equals(currentEntry.CadDocumentId, CadDocumentId, StringComparison.Ordinal)
            && string.Equals(checkout.CheckoutId, CheckoutId, StringComparison.Ordinal)
            && string.Equals(checkout.BaseFileVersionId, BaseFileVersionId, StringComparison.Ordinal);
    }

    internal static bool RootsEqual(string? a, string? b)
    {
        if (string.IsNullOrWhiteSpace(a) || string.IsNullOrWhiteSpace(b))
        {
            return false;
        }
        static string Norm(string p)
        {
            try { p = Path.GetFullPath(p); } catch { /* keep as-is */ }
            return p.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        return string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// Holds at most ONE remembered Undo target (option B: the most-recently
/// active exact checkout target - never a guess across multiple checkouts).
/// Pure: the Inventor layer feeds it the active-document context and a manifest
/// lookup; it never does I/O itself.
/// </summary>
public sealed class UndoTargetMemory
{
    public RememberedCheckoutTarget? Current { get; private set; }

    /// <summary>
    /// If <paramref name="activeDoc"/> is a managed file this session currently
    /// holds checked out, remember it as the Undo target. Otherwise leave the
    /// existing target untouched (it must survive the document closing).
    /// </summary>
    public void Observe(CadDocumentContext activeDoc)
    {
        if (activeDoc.CheckoutState == LocalCheckoutState.CheckedOutByMe
            && activeDoc.PlmIdentity is { } id
            && activeDoc.CheckoutBinding is { } checkout
            && !string.IsNullOrEmpty(activeDoc.FullPath)
            && !string.IsNullOrEmpty(activeDoc.WorkspaceRoot)
            && !string.IsNullOrEmpty(checkout.CheckoutId)
            && !string.IsNullOrEmpty(checkout.BaseFileVersionId))
        {
            Current = new RememberedCheckoutTarget(
                ManagedFileRef.Create(activeDoc.WorkspaceRoot!, activeDoc.FullPath!),
                id.CadDocumentId,
                checkout.CheckoutId,
                checkout.BaseFileVersionId,
                string.IsNullOrEmpty(id.DocumentNumber) ? id.CadDocumentId : id.DocumentNumber!);
        }
    }

    /// <summary>
    /// Forget the remembered target unless it is still an exact,
    /// currently-checked-out manifest binding in the current workspace whose
    /// local file is present on disk.
    /// </summary>
    /// <returns>R10 MA-7: why the target was dropped (one of the
    ///  <see cref="UndoTargetDropReason"/> codes), or null when it was kept or
    ///  there was none. Diagnostics only - the decision is unchanged.</returns>
    public string? Revalidate(
        Func<ManagedFileRef, WorkspaceManifestEntry?> entryLookup,
        Func<string, bool> fileExists,
        string? currentWorkspaceRoot)
    {
        if (Current is null)
        {
            return null;
        }
        var entry = entryLookup(Current.File);
        var reason = Current.IsStillUndoable(entry, currentWorkspaceRoot)
            ? (fileExists(Current.File.AbsoluteFilePath) ? null : UndoTargetDropReason.FileMissing)
            : UndoTargetDropReason.Classify(Current, entry, currentWorkspaceRoot);
        if (reason is not null)
        {
            Current = null;
        }
        return reason;
    }

    /// <summary>Unconditionally forget (sign-out, explicit undo/check-in completion).</summary>
    public void Clear() => Current = null;

    /// <summary>
    /// R10 MA-7 fallback: the Undo target when nothing is remembered (the
    /// in-memory target can be lost while the document is closed). Returns a
    /// target ONLY when the selected workspace's manifest holds EXACTLY ONE
    /// entry with a checkout marker, that marker is complete (the same rules
    /// the orchestrator applies before Undo), the entry's path resolves safely
    /// inside the workspace, and the file exists. Anything else - no marker,
    /// two or more markers, an incomplete marker, an unsafe path, a missing
    /// file - recovers nothing. Pure: the caller supplies the entries.
    ///
    /// This only enables the ribbon command and names the target in the
    /// confirmation dialog. Undo itself still re-checks the manifest, refuses
    /// an open document and verifies the checkout with the server.
    /// </summary>
    public static UndoTargetRecovery ResolveFromWorkspace(
        IEnumerable<WorkspaceManifestEntry>? entries,
        string? workspaceRoot,
        Func<string, bool> fileExists)
    {
        if (string.IsNullOrWhiteSpace(workspaceRoot))
        {
            return UndoTargetRecovery.None(UndoTargetRecovery.NoWorkspace, 0);
        }

        var marked = (entries ?? []).Where(e => e?.Checkout is not null).ToList();
        if (marked.Count == 0)
        {
            return UndoTargetRecovery.None(UndoTargetRecovery.NoCheckout, 0);
        }
        if (marked.Count > 1)
        {
            return UndoTargetRecovery.None(UndoTargetRecovery.Ambiguous, marked.Count);
        }

        var entry = marked[0];
        var marker = entry.Checkout!;
        if (!WorkspaceManifest.IsWellFormedId(entry.CadDocumentId) || !IsCompleteCheckoutRecord(marker))
        {
            return UndoTargetRecovery.None(UndoTargetRecovery.Incomplete, 1);
        }

        string absolutePath;
        try
        {
            absolutePath = SafeWorkspacePath.ResolveWithinRoot(workspaceRoot, entry.RelativePath);
        }
        catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException or ArgumentException)
        {
            return UndoTargetRecovery.None(UndoTargetRecovery.UnsafePath, 1);
        }
        if (!fileExists(absolutePath))
        {
            return UndoTargetRecovery.None(UndoTargetRecovery.FileMissing, 1);
        }

        var target = new RememberedCheckoutTarget(
            ManagedFileRef.Create(workspaceRoot, absolutePath),
            entry.CadDocumentId,
            marker.CheckoutId,
            marker.BaseFileVersionId,
            string.IsNullOrEmpty(entry.DocumentNumber) ? entry.CadDocumentId : entry.DocumentNumber);
        return new UndoTargetRecovery(target, UndoTargetRecovery.Recovered, 1);
    }

    /// <summary>The orchestrator's complete-marker rules (R10
    ///  <c>CheckoutOrchestrator.IsCompleteMarker</c>), repeated here because
    ///  that one is private to the Api layer. Undo re-applies the original.</summary>
    public static bool IsCompleteCheckoutRecord(WorkspaceCheckoutBinding? marker) =>
        marker is not null
        && WorkspaceManifest.IsWellFormedId(marker.CheckoutId)
        && WorkspaceManifest.IsWellFormedId(marker.BaseFileVersionId)
        && marker.BaseVersionNumber > 0
        && References.FileVersionIntegrity.IsCanonicalSha256(marker.BaseChecksum)
        && marker.BaseFileSize > 0
        && marker.CheckedOutAtUtc != default;
}

/// <summary>R10 MA-7: the result of <see cref="UndoTargetMemory.ResolveFromWorkspace"/>.
///  <see cref="Outcome"/> is a fixed diagnostic code; <see cref="CheckoutCount"/>
///  is how many manifest entries carried a checkout marker.</summary>
public sealed record UndoTargetRecovery(RememberedCheckoutTarget? Target, string Outcome, int CheckoutCount)
{
    public const string Recovered = "recovered";
    public const string NoWorkspace = "no-workspace";
    public const string NoCheckout = "no-checkout";
    public const string Ambiguous = "ambiguous";
    public const string Incomplete = "incomplete";
    public const string UnsafePath = "unsafe-path";
    public const string FileMissing = "file-missing";

    internal static UndoTargetRecovery None(string outcome, int count) => new(null, outcome, count);
}

/// <summary>R10 MA-7: diagnostic codes for why a remembered Undo target was
///  dropped. Only ever logged; they never change a decision.</summary>
public static class UndoTargetDropReason
{
    public const string EntryMissing = "entry-missing";
    public const string MarkerCleared = "marker-cleared";
    public const string WorkspaceChanged = "workspace-changed";
    public const string IdentityChanged = "identity-changed";
    public const string FileMissing = "file-missing";

    /// <summary>Which <see cref="RememberedCheckoutTarget.IsStillUndoable"/>
    ///  check failed, in the same order it checks them.</summary>
    internal static string Classify(RememberedCheckoutTarget target, WorkspaceManifestEntry? entry, string? currentWorkspaceRoot)
    {
        if (entry is null) return EntryMissing;
        if (entry.Checkout is null) return MarkerCleared;
        return RememberedCheckoutTarget.RootsEqual(target.File.WorkspaceRoot, currentWorkspaceRoot)
            ? IdentityChanged
            : WorkspaceChanged;
    }
}
