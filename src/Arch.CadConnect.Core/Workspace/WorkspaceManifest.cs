using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Arch.CadConnect.Core.Workspace;

/// <summary>
/// The managed-cache metadata a Get Latest writes to
/// <c>&lt;workspaceRoot&gt;\.arch\workspace.json</c>. It binds a local file at
/// <c>root + relativePath</c> to a STABLE Arch identity (cadDocumentId /
/// fileVersionId) because the client RECORDED it from a server response -
/// never because of the file's name.
///
/// AUTHORITY: this file is a cache, never authoritative. The server is. A
/// missing / corrupt / unreadable manifest is treated as "no bindings" by
/// everything that only reads it. P6 M4.4 Package C: Get Latest, which rewrites
/// it, refuses an unreadable one - see <see cref="Load"/> - and only a missing
/// one is built anew.
///
/// TRUTHFULNESS (PM control 1): an entry is only marked
/// <see cref="WorkspaceManifestEntryState.Verified"/> when the local file's
/// bytes were successfully size + SHA-256 checked THIS run
/// (Downloaded / AlreadyCurrent). If a run cannot verify a path that a
/// previous run had bound (a local-conflict, or a failed download), its entry
/// is downgraded to <see cref="WorkspaceManifestEntryState.Unverified"/> -
/// the identity binding is kept (useful for later checkout), but the manifest
/// never claims the file is a current verified copy when it is not. A
/// partial/failed run only ever calls <see cref="ApplyRun"/> +
/// <see cref="SaveAtomic"/> for what it actually verified; if materialization
/// threw, the manifest is not touched at all.
/// </summary>
public sealed class WorkspaceManifest
{
    public const string SchemaId = "arch-plm.workspace-manifest.v1";
    public const string RelativeManifestPath = @".arch\workspace.json";

    private const string SetAsideSuffix = ".previous";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly string _root;
    private WorkspaceManifestDocument _doc;

    /// <summary>The SHA-256 of the file this was read from, or null if there
    ///  was none: what <see cref="SaveIfUnchangedSinceLoad"/> expects to find.</summary>
    private byte[]? _diskSha256;

    private WorkspaceManifest(string root, WorkspaceManifestDocument doc, byte[]? diskSha256 = null)
    {
        _root = root;
        _doc = doc;
        _diskSha256 = diskSha256;
    }

    public string ManifestFilePath => Path.Combine(_root, RelativeManifestPath);

    public IReadOnlyList<WorkspaceManifestEntry> Entries => _doc.Entries;

    /// <summary>The server this record says it belongs to, as read.</summary>
    public string ServerOrigin => _doc.ServerOrigin;

    /// <summary>The organization this record says it belongs to, as read. Blank
    ///  in a record from before organizations were recorded.</summary>
    public string OrganizationId => _doc.OrganizationId;

    /// <summary>
    /// Load the manifest under <paramref name="workspaceRoot"/>, or an empty
    /// one if it is missing / corrupt / the wrong schema. Never throws for a
    /// bad file.
    /// </summary>
    public static WorkspaceManifest LoadOrEmpty(string workspaceRoot) => Load(workspaceRoot).Manifest;

    /// <summary>
    /// P6 M4.4 Package C: <see cref="LoadOrEmpty"/>, also saying WHY the result
    /// is what it is - a command that would rewrite the manifest must not take
    /// an unreadable file for an empty workspace. Never throws for a bad file.
    /// </summary>
    public static (WorkspaceManifest Manifest, WorkspaceManifestLoadStatus Status) Load(string workspaceRoot)
    {
        SafeWorkspacePath.RequireAbsoluteRoot(workspaceRoot);
        var root = Path.GetFullPath(workspaceRoot);
        var path = Path.Combine(root, RelativeManifestPath);

        try
        {
            if (File.Exists(path))
            {
                var bytes = File.ReadAllBytes(path);
                using var text = new StreamReader(new MemoryStream(bytes));
                var doc = JsonSerializer.Deserialize<WorkspaceManifestDocument>(text.ReadToEnd(), Json);
                if (doc is not null && doc.Schema == SchemaId && doc.Entries is not null)
                {
                    return (new WorkspaceManifest(root, doc, SHA256.HashData(bytes)), WorkspaceManifestLoadStatus.Loaded);
                }
            }
            else
            {
                return (new WorkspaceManifest(root, WorkspaceManifestDocument.Empty(SchemaId)), WorkspaceManifestLoadStatus.Missing);
            }
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            // fall through - treat as no bindings
        }

        return (new WorkspaceManifest(root, WorkspaceManifestDocument.Empty(SchemaId)), WorkspaceManifestLoadStatus.Invalid);
    }

    /// <summary>
    /// Merge one completed Get Latest run into the in-memory manifest.
    /// - Verified entries (Downloaded / AlreadyCurrent): identity + verified
    ///   checksum + retrieval time recorded.
    /// - Blocked / Failed for a path already bound: downgraded to Unverified
    ///   (identity kept, no currency claim).
    /// - Blocked / Failed for a path NOT bound: no entry written.
    /// - Entries for paths outside this run's plan: preserved untouched.
    /// - P6 M4.4 Package C: <see cref="MaterializationEntryResult.ManifestAction"/>
    ///   overrides these for a checked-out entry.
    /// Call <see cref="SaveAtomic"/> afterwards to persist.
    /// </summary>
    public void ApplyRun(
        MaterializationReport report,
        WorkspacePlan plan,
        WorkspaceManifestRunContext context,
        DateTimeOffset nowUtc)
    {
        var byPath = _doc.Entries.ToDictionary(e => Key(e.RelativePath), StringComparer.OrdinalIgnoreCase);
        var planByDoc = plan.Entries.ToDictionary(e => e.CadDocumentId);

        foreach (var result in report.Results)
        {
            if (result.RelativePath is null)
            {
                continue; // never resolved a path - nothing to bind
            }
            if (result.ManifestAction == MaterializationManifestAction.PreserveEntry)
            {
                continue;
            }
            var key = Key(result.RelativePath);
            planByDoc.TryGetValue(result.CadDocumentId, out var planEntry);

            switch (result.Status)
            {
                case MaterializationStatus.Downloaded:
                case MaterializationStatus.AlreadyCurrent:
                    var heldCheckout = result.ManifestAction == MaterializationManifestAction.KeepCheckout
                        && byPath.TryGetValue(key, out var held) ? held.Checkout : null;
                    byPath[key] = new WorkspaceManifestEntry
                    {
                        RelativePath = result.RelativePath,
                        CadDocumentId = result.CadDocumentId,
                        DocumentNumber = result.DocumentNumber ?? planEntry?.DocumentNumber ?? "",
                        FileName = planEntry?.FileName ?? "",
                        CadType = planEntry?.CadType ?? "",
                        FileVersionId = result.FileVersionId ?? planEntry?.Version?.FileVersionId ?? "",
                        VersionNumber = planEntry?.Version?.VersionNumber ?? 0,
                        Checksum = result.Checksum ?? planEntry?.Version?.Checksum ?? "",
                        FileSize = planEntry?.Version?.FileSize ?? 0,
                        IsRoot = planEntry?.IsRoot ?? result.IsRoot,
                        DependsOn = planEntry?.DependsOn.Select(d => d.CadDocumentId).ToArray() ?? [],
                        State = WorkspaceManifestEntryState.Verified,
                        RetrievedAtUtc = nowUtc,
                        Checkout = heldCheckout,
                    };
                    break;

                case MaterializationStatus.Blocked:
                case MaterializationStatus.Failed:
                    if (byPath.TryGetValue(key, out var prior))
                    {
                        byPath[key] = prior with
                        {
                            State = WorkspaceManifestEntryState.Unverified,
                        };
                    }
                    break;
            }
        }

        // P6 M4.4 Package C: the manifest's root names a document this workspace
        // verifiably holds, never one this run could not make current.
        var rootIsCurrent = report.Results.Any(r =>
            string.Equals(r.CadDocumentId, context.RootCadDocumentId, StringComparison.Ordinal)
            && r.Status is MaterializationStatus.Downloaded or MaterializationStatus.AlreadyCurrent);

        _doc = _doc with
        {
            Schema = SchemaId,
            ServerOrigin = context.ServerOrigin,
            OrganizationId = context.OrganizationId,
            OrganizationCode = context.OrganizationCode,
            RootCadDocumentId = rootIsCurrent ? context.RootCadDocumentId : _doc.RootCadDocumentId,
            RootDocumentNumber = rootIsCurrent ? context.RootDocumentNumber : _doc.RootDocumentNumber,
            UpdatedAtUtc = nowUtc,
            Entries = byPath.Values
                .OrderBy(e => e.RelativePath, StringComparer.OrdinalIgnoreCase)
                .ToArray(),
        };
    }

    /// <summary>
    /// Write the manifest atomically (temp file + replace). The on-disk files
    /// stay valid whether or not this succeeds - the temp file is cleaned up
    /// on failure and the previous manifest is left in place - but a failure
    /// is now OBSERVABLE: it throws <see cref="WorkspaceManifestPersistException"/>
    /// so a state-changing P4C operation can report that its local record was
    /// not durably saved (the server remains authoritative; recovery is a
    /// Get Latest).
    /// </summary>
    /// <exception cref="WorkspaceManifestPersistException">the temp write or
    ///  the atomic replace failed (permissions, IO, the file held open, …).</exception>
    public void SaveAtomic()
    {
        var path = ManifestFilePath;
        var dir = Path.GetDirectoryName(path)!;

        var tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(_doc, Json);
        try
        {
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(tmp, bytes);
            File.Move(tmp, path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            try { File.Delete(tmp); } catch { /* best effort */ }
            throw new WorkspaceManifestPersistException(
                $"Could not save the workspace manifest ({ex.GetType().Name}).", ex);
        }
    }

    /// <summary>
    /// P6 M4.4 Package C: <see cref="SaveAtomic"/> for a run that loaded this
    /// manifest, held <c>.arch</c> throughout and must not write over anything
    /// it did not read. NTFS cannot both hold a file against everyone and
    /// replace it atomically: a replace needs a target opened with delete
    /// sharing, and that same sharing lets anyone else replace or rename it. So
    /// nothing is replaced. The file is pinned with no sharing and verified, then
    /// that same object is renamed aside through its handle, and the new file
    /// takes the path create-new, so the only bytes ever displaced are the bytes
    /// verified, and a file that lands on the empty path stays.
    ///
    /// Only this process, through the handle it verified, ever puts that file
    /// back. After a restart nothing does: <see cref="WorkspaceRecoveryState"/>
    /// reports what a dead process left, and a person resolves it.
    /// </summary>
    /// <returns>Null when nothing is left beside the manifest; otherwise the
    ///  workspace-relative path of the old file, which stayed although the new
    ///  manifest was saved.</returns>
    /// <exception cref="WorkspaceManifestChangedException">The file on disk is
    ///  not the one loaded. It was left as it is.</exception>
    /// <exception cref="WorkspaceManifestPersistException">Continuity could not
    ///  be established or the save could not finish. Nothing was overwritten.</exception>
    public string? SaveIfUnchangedSinceLoad() => SaveIfUnchangedSinceLoad(atStep: null);

    /// <param name="atStep">Test hook: runs at each <see cref="ManifestSaveStep"/>.</param>
    /// <param name="deletePrevious">Test hook: replaces deleting the old file.</param>
    /// <param name="placeNew">Test hook: replaces placing the new file.</param>
    internal string? SaveIfUnchangedSinceLoad(
        Action<ManifestSaveStep>? atStep = null,
        Func<PinnedRecoveryCopy, bool>? deletePrevious = null,
        Func<PinnedRecoveryCopy, string, bool>? placeNew = null)
    {
        var path = ManifestFilePath;
        var tmp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        var bytes = JsonSerializer.SerializeToUtf8Bytes(_doc, Json);
        var sha256 = SHA256.HashData(bytes);
        try
        {
            using (var file = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                file.Write(bytes);
                file.Flush(flushToDisk: true);
            }
            using var next = PinnedRecoveryCopy.TryOpen(tmp) ?? throw new IOException("The new manifest could not be held.");
            if (!IsHolding(next, sha256))
            {
                throw new IOException("The new manifest changed before it could be saved.");
            }
            atStep?.Invoke(ManifestSaveStep.TemporaryWritten);

            string? retained = null;
            if (_diskSha256 is { } loaded)
            {
                retained = ReplaceVerified(path, loaded, next, atStep, deletePrevious ?? (previous => previous.TryDelete()), placeNew ?? ((file, target) => file.TryRenameTo(target)));
            }
            else
            {
                atStep?.Invoke(ManifestSaveStep.Verified);
                if (!next.TryRenameTo(path))
                {
                    throw PinnedWorkspaceFolder.ExistsByName(path)
                        ? new WorkspaceManifestChangedException()
                        : new IOException("The new manifest could not be put in place.");
                }
                atStep?.Invoke(ManifestSaveStep.Placed);
            }
            _diskSha256 = sha256;
            return retained is null ? null : Path.GetRelativePath(_root, retained);
        }
        catch (Exception ex) when (ex is WorkspaceManifestChangedException or WorkspaceManifestPersistException)
        {
            try { File.Delete(tmp); } catch { /* best effort */ }
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            try { File.Delete(tmp); } catch { /* best effort */ }
            throw new WorkspaceManifestPersistException(
                $"Could not save the workspace manifest ({ex.GetType().Name}).", ex);
        }
    }

    /// <returns>The old file's path, if it is still there once the handle has
    ///  closed: a deletion only happens then, so only then can it be confirmed.</returns>
    private string? ReplaceVerified(
        string path, byte[] loaded, PinnedRecoveryCopy next, Action<ManifestSaveStep>? atStep,
        Func<PinnedRecoveryCopy, bool> deletePrevious, Func<PinnedRecoveryCopy, string, bool> placeNew)
    {
        var setAside = path + "." + Guid.NewGuid().ToString("N") + SetAsideSuffix;
        using (var current = PinnedRecoveryCopy.TryOpen(path))
        {
            if (current is null)
            {
                throw WorkspaceRecoveryFolder.ProbeCopy(path) == RecoveryCopyPresence.Absent
                    ? new WorkspaceManifestChangedException()
                    : new IOException("The workspace manifest could not be held.");
            }
            if (!IsHolding(current, loaded))
            {
                throw new WorkspaceManifestChangedException();
            }
            atStep?.Invoke(ManifestSaveStep.Verified);

            if (!current.TryRenameTo(setAside))
            {
                throw new IOException("The workspace manifest could not be set aside.");
            }
            atStep?.Invoke(ManifestSaveStep.SetAside);

            if (!placeNew(next, path))
            {
                if (PinnedWorkspaceFolder.ExistsByName(path))
                {
                    // Whatever took the path stays; so does the verified file beside it.
                    throw new WorkspaceManifestChangedException(Path.GetRelativePath(_root, setAside));
                }
                if (!current.TryRenameTo(path))
                {
                    throw new WorkspaceManifestPersistException(
                        "The new workspace manifest could not be put in place, and the old one could not be put back.",
                        retainedArtifact: Path.GetRelativePath(_root, setAside));
                }
                throw new IOException("The new manifest could not be put in place.");
            }
            atStep?.Invoke(ManifestSaveStep.Placed);

            deletePrevious(current);
            atStep?.Invoke(ManifestSaveStep.DeleteMarked);
        }
        return WorkspaceRecoveryFolder.ProbeCopy(setAside) == RecoveryCopyPresence.Absent ? null : setAside;
    }

    /// <summary>P6 M4.4 Package C: whether <c>workspace.json</c> is still what this
    ///  object loaded, or still absent. Anything that cannot be read counts as
    ///  changed. This is a checkpoint before work starts; the save verifies again
    ///  under its own hold.</summary>
    public bool IsUnchangedOnDisk()
    {
        try
        {
            var path = ManifestFilePath;
            if (_diskSha256 is not { } loaded)
            {
                return !PinnedWorkspaceFolder.ExistsByName(path);
            }
            return SHA256.HashData(File.ReadAllBytes(path)).AsSpan().SequenceEqual(loaded);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsHolding(PinnedRecoveryCopy file, byte[] sha256) =>
        SHA256.HashData(file.Content).AsSpan().SequenceEqual(sha256);

    /// <summary>The manifest entry, if any, for an ABSOLUTE local file path
    ///  under this workspace root. Case-insensitive. Never infers - only an
    ///  exact <c>root + relativePath</c> match counts.</summary>
    public WorkspaceManifestEntry? FindByAbsolutePath(string absoluteFilePath)
    {
        if (string.IsNullOrWhiteSpace(absoluteFilePath) || !Path.IsPathFullyQualified(absoluteFilePath))
        {
            return null;
        }
        var full = Path.GetFullPath(absoluteFilePath);
        foreach (var entry in _doc.Entries)
        {
            string candidate;
            try
            {
                candidate = SafeWorkspacePath.ResolveWithinRoot(_root, entry.RelativePath);
            }
            catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException)
            {
                continue;
            }
            if (string.Equals(candidate, full, StringComparison.OrdinalIgnoreCase))
            {
                return entry;
            }
        }
        return null;
    }

    /// <summary>P6 M4.4 Package C: whether every entry names a document and a
    ///  safe path, and no two share a path. A manifest that parses but fails
    ///  this cannot be trusted to say which file holds which checkout. Asked
    ///  by Get Latest, which rewrites the manifest; readers keep their rules.</summary>
    public bool HasSoundEntries()
    {
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in _doc.Entries)
        {
            if (entry is null
                || string.IsNullOrWhiteSpace(entry.RelativePath)
                || !IsWellFormedId(entry.CadDocumentId)
                || !paths.Add(Key(entry.RelativePath)))
            {
                return false;
            }
            try
            {
                SafeWorkspacePath.ResolveWithinRoot(_root, entry.RelativePath);
            }
            catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException)
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>Exactly as the server issued it: an id that needed trimming or
    ///  cleaning would become a different identity, so it is refused as it is.</summary>
    public static bool IsWellFormedId(string? id) =>
        !string.IsNullOrWhiteSpace(id)
        && id == id.Trim()
        && !id.Any(char.IsControl);

    /// <summary>The manifest entry, if any, bound to a path relative to this
    ///  workspace root. Case-insensitive.</summary>
    public WorkspaceManifestEntry? FindByRelativePath(string relativePath) =>
        _doc.Entries.FirstOrDefault(e => string.Equals(Key(e.RelativePath), Key(relativePath), StringComparison.OrdinalIgnoreCase));

    /// <summary>The manifest entry AND its resolved absolute path, if any,
    ///  for a STABLE <paramref name="cadDocumentId"/> bound in this
    ///  workspace. P6D: lets a real drawing-association source enrich an
    ///  authoritative (server-confirmed) drawing with the LOCAL absolute
    ///  path it already sits at, when a prior Get Latest already
    ///  materialized it - never the reverse (this is never used to prove
    ///  the association itself; the server's DRAWING_REFERENCE row already
    ///  did that). No match (not yet fetched into this workspace) returns
    ///  <c>null</c> - a legitimate "claimed but unresolved" state, never a
    ///  guess.</summary>
    public (WorkspaceManifestEntry Entry, string AbsolutePath)? FindByCadDocumentId(string cadDocumentId)
    {
        if (string.IsNullOrWhiteSpace(cadDocumentId))
        {
            return null;
        }
        foreach (var entry in _doc.Entries)
        {
            if (!string.Equals(entry.CadDocumentId, cadDocumentId, StringComparison.Ordinal))
            {
                continue;
            }
            try
            {
                return (entry, SafeWorkspacePath.ResolveWithinRoot(_root, entry.RelativePath));
            }
            catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException)
            {
                return null;
            }
        }
        return null;
    }

    // ---- P4C: checkout state (all mutate the matching entry ONLY, then
    //      persist atomically; never create an entry - identity must come
    //      from a prior Get Latest). Matched by exact absolute path, never by
    //      filename. Return VALUE: true = an entry matched and was saved;
    //      false = no entry matched (nothing written). THROWS
    //      WorkspaceManifestPersistException when an entry matched but the
    //      durable save failed - callers of a state-changing operation MUST
    //      treat that as "local record not reconciled". -----------------

    /// <summary>Record that THIS user holds the server checkout of the file at
    ///  <paramref name="absoluteFilePath"/>. Snapshots the exact base
    ///  FileVersion identity + checksum + size so Undo has an authoritative
    ///  target even if the entry's own version fields later drift.</summary>
    public bool MarkCheckedOut(string absoluteFilePath, WorkspaceCheckoutBinding binding)
        => UpdateEntry(absoluteFilePath, e => e with { Checkout = binding });

    /// <summary>The change <see cref="MarkCheckedOut"/> makes, in memory only: for
    ///  the crash tests, which need a genuinely different manifest to save.</summary>
    internal bool StageCheckedOut(string absoluteFilePath, WorkspaceCheckoutBinding binding)
        => ChangeEntry(absoluteFilePath, e => e with { Checkout = binding });

    /// <summary>Clear the local checkout marker (after a successful check-in or
    ///  undo). Identity + version fields are untouched.</summary>
    public bool ClearCheckout(string absoluteFilePath)
        => UpdateEntry(absoluteFilePath, e => e with { Checkout = null });

    /// <summary>After a verified check-in: point the entry at the NEW immutable
    ///  FileVersion, mark it Verified, and clear the checkout marker.</summary>
    public bool RebindToNewVersion(
        string absoluteFilePath,
        string fileVersionId,
        int versionNumber,
        string checksum,
        long fileSize,
        DateTimeOffset nowUtc,
        WorkspaceManifestEntryState state = WorkspaceManifestEntryState.Verified)
        => UpdateEntry(absoluteFilePath, e => e with
        {
            FileVersionId = fileVersionId,
            VersionNumber = versionNumber,
            Checksum = checksum,
            FileSize = fileSize,
            State = state,
            RetrievedAtUtc = nowUtc,
            Checkout = null,
        });

    /// <summary>Mark the entry Unverified: identity is kept, but the local
    ///  file's current bytes are NOT a confirmed copy of the pinned version.
    ///  Used when a materialize / restore could not be completed.</summary>
    public bool MarkUnverified(string absoluteFilePath, bool clearCheckout = false)
        => UpdateEntry(absoluteFilePath, e => e with
        {
            State = WorkspaceManifestEntryState.Unverified,
            Checkout = clearCheckout ? null : e.Checkout,
        });

    private bool UpdateEntry(string absoluteFilePath, Func<WorkspaceManifestEntry, WorkspaceManifestEntry> mutate)
    {
        if (!ChangeEntry(absoluteFilePath, mutate))
        {
            return false;
        }
        SaveAtomic();
        return true;
    }

    private bool ChangeEntry(string absoluteFilePath, Func<WorkspaceManifestEntry, WorkspaceManifestEntry> mutate)
    {
        var target = FindByAbsolutePath(absoluteFilePath);
        if (target is null)
        {
            return false;
        }
        var key = Key(target.RelativePath);
        _doc = _doc with
        {
            Entries = _doc.Entries
                .Select(e => string.Equals(Key(e.RelativePath), key, StringComparison.OrdinalIgnoreCase) ? mutate(e) : e)
                .ToArray(),
        };
        return true;
    }

    private static string Key(string relativePath) => relativePath.Trim();
}

/// <summary>What <see cref="WorkspaceManifest.Load"/> found on disk.</summary>
public enum WorkspaceManifestLoadStatus
{
    /// <summary>No manifest file: a new workspace.</summary>
    Missing,

    Loaded,

    /// <summary>A file exists but could not be read, or is corrupt, or has an
    ///  unsupported schema.</summary>
    Invalid,
}

/// <summary>
/// The workspace manifest could not be written durably (temp write, atomic
/// replace, permissions, IO, the file held open, …). The on-disk files remain
/// valid and the previous manifest is untouched; the SERVER stays
/// authoritative and recovery is a Get Latest. Callers of a state-changing
/// P4C operation must surface this as "local record not reconciled" - never
/// as a false success.
/// </summary>
public sealed class WorkspaceManifestPersistException(string message, Exception? inner = null, string? retainedArtifact = null)
    : Exception(message, inner)
{
    /// <summary>The workspace-relative path of an old manifest left set aside.</summary>
    public string? RetainedArtifact { get; } = retainedArtifact;
}

/// <summary>P6 M4.4 Package C: <c>workspace.json</c> is not the file this run
///  loaded, so it holds something the run knows nothing about and was left
///  alone.</summary>
public sealed class WorkspaceManifestChangedException(string? retainedArtifact = null)
    : Exception("The workspace manifest changed after it was loaded.")
{
    /// <summary>The workspace-relative path of the verified manifest, when it
    ///  had already been set aside.</summary>
    public string? RetainedArtifact { get; } = retainedArtifact;
}

/// <summary>The points of a manifest save a process can die between.</summary>
public enum ManifestSaveStep
{
    /// <summary>The new file is durable under its temporary name.</summary>
    TemporaryWritten,

    /// <summary>The old file is pinned and verified; nothing has moved.</summary>
    Verified,

    /// <summary>The old file is aside and the path is empty.</summary>
    SetAside,

    /// <summary>The new file is at the path; the old one is still aside.</summary>
    Placed,

    /// <summary>The old file is marked for deletion; its handle is still open.</summary>
    DeleteMarked,
}

/// <summary>
/// Local record that THIS client holds the server checkout of one managed
/// file. It is a cache of server-authoritative state (the server
/// <c>CadCheckout</c> row is the truth); it exists so the ribbon and Undo can
/// work without a round-trip and so Undo knows the EXACT base FileVersion to
/// restore. Never used as identity - the entry's <c>cadDocumentId</c> is.
/// </summary>
public sealed record WorkspaceCheckoutBinding
{
    [JsonPropertyName("checkoutId")] public string CheckoutId { get; init; } = "";
    [JsonPropertyName("baseFileVersionId")] public string BaseFileVersionId { get; init; } = "";
    [JsonPropertyName("baseVersionNumber")] public int BaseVersionNumber { get; init; }
    [JsonPropertyName("baseChecksum")] public string BaseChecksum { get; init; } = "";
    [JsonPropertyName("baseFileSize")] public long BaseFileSize { get; init; }
    [JsonPropertyName("checkedOutAtUtc")] public DateTimeOffset CheckedOutAtUtc { get; init; }
}

public sealed record WorkspaceManifestRunContext(
    string ServerOrigin,
    string OrganizationId,
    string OrganizationCode,
    string RootCadDocumentId,
    string RootDocumentNumber);

public enum WorkspaceManifestEntryState
{
    /// <summary>Bytes verified (size + SHA-256) this run.</summary>
    Verified,

    /// <summary>Identity known, but the local file's current bytes were NOT
    ///  verified against the pinned version this run.</summary>
    Unverified,
}

public sealed record WorkspaceManifestDocument
{
    [JsonPropertyName("schema")] public string Schema { get; init; } = "";
    [JsonPropertyName("serverOrigin")] public string ServerOrigin { get; init; } = "";
    [JsonPropertyName("organizationId")] public string OrganizationId { get; init; } = "";
    [JsonPropertyName("organizationCode")] public string OrganizationCode { get; init; } = "";
    [JsonPropertyName("rootCadDocumentId")] public string RootCadDocumentId { get; init; } = "";
    [JsonPropertyName("rootDocumentNumber")] public string RootDocumentNumber { get; init; } = "";
    [JsonPropertyName("updatedAtUtc")] public DateTimeOffset UpdatedAtUtc { get; init; }
    [JsonPropertyName("entries")] public IReadOnlyList<WorkspaceManifestEntry> Entries { get; init; } = [];

    public static WorkspaceManifestDocument Empty(string schema) => new() { Schema = schema, Entries = [] };
}

public sealed record WorkspaceManifestEntry
{
    [JsonPropertyName("relativePath")] public string RelativePath { get; init; } = "";
    [JsonPropertyName("cadDocumentId")] public string CadDocumentId { get; init; } = "";
    [JsonPropertyName("documentNumber")] public string DocumentNumber { get; init; } = "";
    [JsonPropertyName("fileName")] public string FileName { get; init; } = "";
    [JsonPropertyName("cadType")] public string CadType { get; init; } = "";
    [JsonPropertyName("fileVersionId")] public string FileVersionId { get; init; } = "";
    [JsonPropertyName("versionNumber")] public int VersionNumber { get; init; }
    [JsonPropertyName("checksum")] public string Checksum { get; init; } = "";
    [JsonPropertyName("fileSize")] public long FileSize { get; init; }
    [JsonPropertyName("isRoot")] public bool IsRoot { get; init; }
    [JsonPropertyName("dependsOn")] public IReadOnlyList<string> DependsOn { get; init; } = [];

    [JsonPropertyName("state")]
    [JsonConverter(typeof(JsonStringEnumConverter))]
    public WorkspaceManifestEntryState State { get; init; } = WorkspaceManifestEntryState.Verified;

    [JsonPropertyName("retrievedAtUtc")] public DateTimeOffset RetrievedAtUtc { get; init; }

    /// <summary>P4C: present only while THIS client holds the server checkout
    ///  of this file. Absent in every P4B-era manifest and in the normal
    ///  "controlled" state - JSON omits it when null.</summary>
    [JsonPropertyName("checkout")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public WorkspaceCheckoutBinding? Checkout { get; init; }

    /// <summary>Project to the COM-free identity type used by
    ///  <c>CadDocumentContext</c>.</summary>
    public PlmIdentity ToPlmIdentity() => new(
        CadDocumentId,
        string.IsNullOrEmpty(DocumentNumber) ? null : DocumentNumber,
        string.IsNullOrEmpty(FileVersionId) ? null : FileVersionId,
        VersionNumber == 0 ? null : VersionNumber);
}
