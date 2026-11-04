using System.Security.Cryptography;

using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Workspace;

/// <summary>
/// Materializes an already-fetched, validated <see cref="WorkspacePlan"/>
/// onto the local filesystem under a caller-supplied absolute workspace root.
/// A faithful port of <c>web/app/lib/workspace-materialize-core.ts</c>.
///
/// INVARIANTS
///   - The server / object storage stays authoritative. Nothing here mutates
///     server state or creates an authoritative local database.
///   - Only the EXACT pinned <c>version.contentPath</c> is downloaded - never
///     a re-resolved "latest".
///   - Per entry: validate contentPath -> resolve a safe root-relative flat
///     path -> (existing file? same checksum = already-current, different =
///     blocked, never overwritten) -> stream to a temp file -> verify EXACT
///     byte size AND SHA-256 -> atomic CREATE-NEW promote (never overwrite).
///     P6 M4.4 Package C's ONLY exception: the unchanged base of a checkout the
///     server proved stale gives way to a newer plan version. Even then nothing
///     is overwritten: the file is pinned, hashed and moved aside as one object,
///     and the new version is promoted create-new.
///   - A problem with one entry never aborts the others. Every entry gets a
///     result.
///   - The whole operation is refused (throws) when the plan's contract is
///     wrong or <c>plan.Safe</c> is not true.
/// </summary>
public sealed class WorkspaceMaterializer
{
    private readonly IEditorDocumentStateProbe? _editorProbe;
    private readonly Func<string, bool> _setWritable;
    private readonly Action<string, string> _promoteFile;
    private readonly Func<string, bool, WorkspaceRecoveryFolder?> _openRecovery;
    private readonly Func<PinnedRecoveryCopy, bool> _deleteCopy;
    private readonly Func<string, FileAttributes>? _readCopyAttributes;
    private readonly Action<string>? _whileClearingRecord;

    /// <param name="editorProbe">Whether a document is open in the CAD editor.
    ///  None means NOT KNOWN, never "closed": a stale checkout's file is then
    ///  left alone. A host with no editor passes
    ///  <see cref="NoEditorProbe"/>.</param>
    public WorkspaceMaterializer()
        : this(editorProbe: null)
    {
    }

    /// <param name="editorProbe">See the seam overload.</param>
    public WorkspaceMaterializer(IEditorDocumentStateProbe? editorProbe)
        : this(editorProbe, setWritable: null)
    {
    }

    /// <param name="setWritable">Replaces
    ///  <see cref="Core.Files.ManagedFileGuard.SetWritable"/> in tests.</param>
    /// <param name="promoteFile">Replaces the create-new promotion in tests.</param>
    /// <param name="openRecovery">Replaces opening the recovery folder in tests.</param>
    /// <param name="deleteCopy">Replaces deleting a verified copy in tests.</param>
    /// <param name="readCopyAttributes">Replaces asking whether a copy exists in tests.</param>
    /// <param name="whileClearingRecord">Test hook: runs while a copy's name is held
    ///  for its record's removal.</param>
    internal WorkspaceMaterializer(
        IEditorDocumentStateProbe? editorProbe = null,
        Func<string, bool>? setWritable = null,
        Action<string, string>? promoteFile = null,
        Func<string, bool, WorkspaceRecoveryFolder?>? openRecovery = null,
        Func<PinnedRecoveryCopy, bool>? deleteCopy = null,
        Func<string, FileAttributes>? readCopyAttributes = null,
        Action<string>? whileClearingRecord = null)
    {
        _editorProbe = editorProbe;
        _setWritable = setWritable ?? Core.Files.ManagedFileGuard.SetWritable;
        _promoteFile = promoteFile ?? ((source, target) => File.Move(source, target, overwrite: false));
        _openRecovery = openRecovery ?? WorkspaceRecoveryFolder.TryOpen;
        _deleteCopy = deleteCopy ?? (copy => copy.TryDelete());
        _readCopyAttributes = readCopyAttributes;
        _whileClearingRecord = whileClearingRecord;
    }

    /// <param name="archLease">The caller's hold on <c>.arch</c>, kept beyond
    ///  this call. Without one, this call holds it for itself.</param>

    public async Task<MaterializationReport> MaterializeAsync(
        WorkspacePlan plan,
        string workspaceRoot,
        IContentDownloader downloader,
        CancellationToken ct = default,
        Func<DateTimeOffset>? clock = null,
        IReadOnlyDictionary<string, GetLatestEntryDecision>? decisions = null,
        ArchFolderLease? archLease = null)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(downloader);
        SafeWorkspacePath.RequireAbsoluteRoot(workspaceRoot);
        var now = clock ?? (() => DateTimeOffset.UtcNow);

        if (plan.Contract.Id != WorkspacePlanContract.Id
            || !WorkspacePlanContract.IsSupportedVersion(plan.Contract.Version))
        {
            throw new UnsupportedWorkspaceContractException(
                $"Unsupported workspace contract: \"{plan.Contract.Id}\" / \"{plan.Contract.Version}\".");
        }
        if (!plan.Safe)
        {
            throw new UnsafeWorkspacePlanException(plan.Problems);
        }

        var root = Path.GetFullPath(workspaceRoot);
        var startedAt = now();

        // Case-insensitive cross-entry collision pre-pass (NTFS). A `safe` plan
        // should never contain one - defense in depth.
        var colliding = FindCollidingCadDocumentIds(plan, root);

        var results = new List<MaterializationEntryResult>(plan.Entries.Count);

        // Proven and pinned on first use, for the rest of the run: a run with
        // nothing to download creates no staging folder.
        using var ownLease = archLease is null ? ArchFolderLease.TryBegin(root) : null;
        using var staging = new StagingArea(root, archLease ?? ownLease);

        MaterializationReport Report() => new()
        {
            WorkspaceRoot = root,
            RootCadDocumentId = plan.Root.CadDocumentId,
            StartedAtUtc = startedAt,
            FinishedAtUtc = now(),
            RequestedEntries = plan.Entries.Count,
            Results = results,
        };

        foreach (var entry in plan.Entries)
        {
            try
            {
                ct.ThrowIfCancellationRequested();

                var decision = decisions?.GetValueOrDefault(entry.CadDocumentId);

                // P6 M4.4 Package C: given decisions, no entry proceeds on silence.
                if (decisions is not null && decision is null && entry.CanMaterialize && entry.Version is not null)
                {
                    decision = GetLatestEntryDecision.Block(GetLatestCheckoutPolicy.DecisionMissingReason);
                }
                if (decision?.Handling == GetLatestEntryHandling.Block)
                {
                    results.Add(Base(entry) with
                    {
                        RelativePath = entry.Placement.GeneratedRelativePath,
                        Status = MaterializationStatus.Blocked,
                        Reason = decision.BlockReason,
                        ManifestAction = MaterializationManifestAction.PreserveEntry,
                    });
                    continue;
                }
                var result = colliding.Contains(entry.CadDocumentId)
                    ? Base(entry) with
                    {
                        RelativePath = entry.Placement.GeneratedRelativePath,
                        Status = MaterializationStatus.Blocked,
                        Reason = "local-path-collision: another entry in this plan resolves to the same local path (case-insensitive)",
                    }
                    : await MaterializeEntryAsync(entry, root, downloader, decision, staging, ct).ConfigureAwait(false);

                // P6 M4.4 Package C: an entry a decision applied to keeps its record
                // when the run could not finish it.
                results.Add(decision is { Handling: not GetLatestEntryHandling.Proceed }
                    && result.ManifestAction == MaterializationManifestAction.Default
                    && result.Status is MaterializationStatus.Blocked or MaterializationStatus.Failed
                    ? result with { ManifestAction = MaterializationManifestAction.PreserveEntry }
                    : result);
            }
            catch (OperationCanceledException ex) when (results.Count > 0)
            {
                // P6 M4.4 Package C: an entry is finished or untouched, never in
                // between - the caller must still record the finished ones.
                throw new MaterializationCanceledException(Report(), ex);
            }
        }

        return Report();
    }

    private async Task<MaterializationEntryResult> MaterializeEntryAsync(
        WorkspacePlanEntry entry,
        string root,
        IContentDownloader downloader,
        GetLatestEntryDecision? decision,
        StagingArea staging,
        CancellationToken ct)
    {
        var baseResult = Base(entry);
        var handling = decision?.Handling;

        if (!entry.CanMaterialize || entry.Version is null)
        {
            return baseResult with
            {
                RelativePath = null,
                Status = MaterializationStatus.Blocked,
                Reason = entry.BlockedReasons.Count > 0
                    ? $"Entry cannot be materialized: {string.Join(", ", entry.BlockedReasons)}"
                    : "Entry has no materializable version",
            };
        }

        var version = entry.Version;

        if (version.ContentPath != $"/api/file-versions/{version.FileVersionId}/content")
        {
            return baseResult with
            {
                RelativePath = null,
                Status = MaterializationStatus.Blocked,
                Reason = "Refusing an untrusted contentPath: expected the authenticated file-version content endpoint",
            };
        }

        string absolutePath;
        try
        {
            absolutePath = SafeWorkspacePath.ResolveWithinRoot(root, entry.Placement.GeneratedRelativePath);
        }
        catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException)
        {
            return baseResult with
            {
                RelativePath = entry.Placement.GeneratedRelativePath,
                Status = MaterializationStatus.Blocked,
                Reason = ex.Message,
            };
        }

        var relativePath = entry.Placement.GeneratedRelativePath;

        var markerAction = handling switch
        {
            GetLatestEntryHandling.KeepCheckout => MaterializationManifestAction.KeepCheckout,
            GetLatestEntryHandling.ClearStaleMarker => MaterializationManifestAction.ClearCheckout,
            _ => MaterializationManifestAction.Default,
        };

        // P6 M4.4 Package C: neither the replace nor the read-only attribute may
        // land under a document someone may be working in.
        if (handling == GetLatestEntryHandling.ClearStaleMarker && !IsSafeToChange(absolutePath))
        {
            return DocumentOpen(baseResult, relativePath);
        }

        var replaceStaleBase = false;
        string? retainedCopy = null;

        if (handling == GetLatestEntryHandling.ProceedNewFile && PinnedWorkspaceFolder.ExistsByName(absolutePath))
        {
            return LocalFileAppeared(baseResult, relativePath);
        }

        if (File.Exists(absolutePath))
        {
            if (handling == GetLatestEntryHandling.AdoptIfPathFree)
            {
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Blocked,
                    Reason = GetLatestCheckoutPolicy.PathConflictReason,
                    ManifestAction = MaterializationManifestAction.PreserveEntry,
                };
            }

            (string Sha256, long Size) existing;
            try
            {
                existing = await HashFileAsync(absolutePath, ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Failed,
                    Reason = $"Could not inspect the existing local file: {ex.GetType().Name}",
                };
            }

            if (existing.Sha256 == version.Checksum && existing.Size == version.FileSize)
            {
                // P4C: re-assert "controlled" on an already-current file (a
                // prior run may have left it writable). P6 M4.4 Package C: the
                // reverse for a file the server proved checked out - unchanged
                // bytes do not make it any less checked out.
                if (handling == GetLatestEntryHandling.ClearStaleMarker && !IsSafeToChange(absolutePath))
                {
                    return DocumentOpen(baseResult, relativePath);
                }
                if (handling != GetLatestEntryHandling.KeepCheckout)
                {
                    Core.Files.ManagedFileGuard.SetControlled(absolutePath);
                }
                else if (!_setWritable(absolutePath))
                {
                    return NotWritable(baseResult, relativePath);
                }
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.AlreadyCurrent,
                    Checksum = existing.Sha256,
                    BytesWritten = 0,
                    ManifestAction = markerAction,
                };
            }

            if (handling != GetLatestEntryHandling.ClearStaleMarker)
            {
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Blocked,
                    Reason = "local-conflict: an existing file at this path differs from the pinned FileVersion and was not overwritten",
                    ManifestAction = markerAction,
                };
            }

            // P6 M4.4 Package C: only the exact base of a stale checkout gives
            // way, and only to a newer version. Anything else may be local work.
            if (!IsBaseOf(existing, decision!.Marker!) || version.VersionNumber <= decision.Marker!.BaseVersionNumber)
            {
                return StaleConflict(baseResult, relativePath);
            }
            replaceStaleBase = true;
        }

        if (staging.Path is not { } stagingDir)
        {
            return baseResult with
            {
                RelativePath = relativePath,
                Status = MaterializationStatus.Blocked,
                Reason = GetLatestCheckoutPolicy.StagingFolderUnsafeReason,
                ManifestAction = MaterializationManifestAction.PreserveEntry,
            };
        }

        string stagedPath;
        string stagedSha256;
        long stagedSize;
        try
        {
            (stagedPath, stagedSha256, stagedSize) = await StageDownloadAsync(
                stagingDir, downloader, version.ContentPath, version.FileSize, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return baseResult with
            {
                RelativePath = relativePath,
                Status = MaterializationStatus.Failed,
                Reason = $"Download failed: {DescribeDownloadError(ex)}",
            };
        }

        try
        {
            if (stagedSize != version.FileSize || stagedSha256 != version.Checksum)
            {
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Failed,
                    Reason = $"Integrity check failed: expected {version.FileSize} bytes / {version.Checksum}, "
                           + $"got {stagedSize} bytes / {stagedSha256}",
                };
            }

            try
            {
                if (replaceStaleBase)
                {
                    var replacement = await ReplaceStaleBaseAsync(stagedPath, absolutePath, root, decision!.Marker!, entry, baseResult, relativePath, stagingDir, downloader, ct).ConfigureAwait(false);
                    if (replacement.Refused is not null)
                    {
                        return replacement.Refused;
                    }
                    retainedCopy = replacement.RetainedCopy;
                }
                else
                {
                    // The document may have been opened during the download.
                    if (handling == GetLatestEntryHandling.ClearStaleMarker && !IsSafeToChange(absolutePath))
                    {
                        return DocumentOpen(baseResult, relativePath);
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);

                    // The download took time. The move below is what guarantees
                    // nothing is overwritten; this says why, when something arrived.
                    if (handling == GetLatestEntryHandling.ProceedNewFile && PinnedWorkspaceFolder.ExistsByName(absolutePath))
                    {
                        return LocalFileAppeared(baseResult, relativePath);
                    }
                    // overwrite:false -> throws IOException if the target exists.
                    File.Move(stagedPath, absolutePath, overwrite: false);
                }
            }
            catch (Exception ex) when (replaceStaleBase && ex is IOException or UnauthorizedAccessException)
            {
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Failed,
                    Reason = $"Could not replace the local file: {ex.GetType().Name}",
                };
            }
            catch (IOException)
            {
                return baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Blocked,
                    Reason = "local-conflict: a file appeared at this path during materialization and was not overwritten",
                };
            }

            // P4C: a freshly materialized, verified managed file is
            // "controlled" (read-only) until the user checks it out. P6 M4.4
            // Package C: this one already is, by the base version just restored.
            if (handling != GetLatestEntryHandling.KeepCheckout)
            {
                Core.Files.ManagedFileGuard.SetControlled(absolutePath);
            }
            else if (!_setWritable(absolutePath))
            {
                return NotWritable(baseResult, relativePath);
            }

            return baseResult with
            {
                RelativePath = relativePath,
                Status = MaterializationStatus.Downloaded,
                Checksum = stagedSha256,
                BytesWritten = stagedSize,
                ManifestAction = markerAction,
                RetainedRecoveryCopy = retainedCopy,
                Reason = retainedCopy is null ? null : GetLatestCheckoutPolicy.RecoveryCopyRetainedReason(retainedCopy),
            };
        }
        finally
        {
            TryDelete(stagedPath);
        }
    }

    /// <summary>
    /// Stream <paramref name="contentPath"/> into a fresh
    /// <c>.arch\.staging\&lt;guid&gt;.part</c> file, hashing and size-capping as
    /// it goes. On SUCCESS the staged path is returned for the caller's
    /// verify + atomic-promote step (which then consumes / deletes it). On ANY
    /// unsuccessful path - an oversized response, a source read fault, a
    /// destination write/flush fault, a stream-disposal fault, or cancellation
    /// - the staged <c>.part</c> file is removed before the exception
    /// propagates. Cleanup is best-effort and never masks the original error;
    /// a partial file is never returned and never promoted.
    /// </summary>
    private static async Task<(string Path, string Sha256, long Size)> StageDownloadAsync(
        string stagingDir,
        IContentDownloader downloader,
        string contentPath,
        long maxBytes,
        CancellationToken ct)
    {
        var stagedPath = Path.Combine(stagingDir, Guid.NewGuid().ToString("N") + ".part");

        var source = await downloader.OpenContentStreamAsync(contentPath, ct).ConfigureAwait(false);
        try
        {
            using var sha = SHA256.Create();
            long size = 0;

            await using (var file = new FileStream(stagedPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = await source.ReadAsync(buffer.AsMemory(), ct).ConfigureAwait(false)) > 0)
                {
                    size += read;
                    if (size > maxBytes)
                    {
                        throw new DownloadTooLargeException(maxBytes);
                    }
                    sha.TransformBlock(buffer, 0, read, null, 0);
                    await file.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                }
                sha.TransformFinalBlock([], 0, 0);
                await file.FlushAsync(ct).ConfigureAwait(false);
            }

            // Dispose the source INSIDE the guarded region so a disposal fault
            // is handled exactly like a read fault (staged file removed).
            await source.DisposeAsync().ConfigureAwait(false);

            return (stagedPath, Convert.ToHexString(sha.Hash!).ToLowerInvariant(), size);
        }
        catch
        {
            // ANY unsuccessful path - oversized response, a source read fault,
            // a destination write/flush fault, a stream-disposal fault, or
            // cancellation - removes the staged .part file before the
            // exception propagates. The secondary dispose + the delete are
            // best-effort and never mask the original error; a partial file is
            // never returned and never promoted.
            try { await source.DisposeAsync().ConfigureAwait(false); }
            catch { /* the real error is already in flight */ }
            TryDelete(stagedPath);
            throw;
        }
    }

    private static bool IsBaseOf((string Sha256, long Size) file, WorkspaceCheckoutBinding marker) =>
        file.Sha256 == marker.BaseChecksum && file.Size == marker.BaseFileSize;

    private static MaterializationEntryResult StaleConflict(MaterializationEntryResult baseResult, string relativePath) => baseResult with
    {
        RelativePath = relativePath,
        Status = MaterializationStatus.Blocked,
        Reason = GetLatestCheckoutPolicy.StaleConflictReason,
        ManifestAction = MaterializationManifestAction.PreserveEntry,
    };

    /// <summary>The Undo Checkout pre-flight, stricter: the editor must be known
    ///  not to have the document open and no process may hold the file. Anything
    ///  that cannot be answered counts as not safe.</summary>
    private bool IsSafeToChange(string absolutePath)
    {
        if (_editorProbe is null)
        {
            return false;
        }
        try
        {
            return _editorProbe.GetDocumentState(absolutePath) == EditorDocumentState.Closed
                && Core.Files.ManagedFileGuard.CanReplaceInPlace(absolutePath);
        }
        catch (Exception)
        {
            return false;
        }
    }

    private static MaterializationEntryResult DocumentOpen(MaterializationEntryResult baseResult, string relativePath) => baseResult with
    {
        RelativePath = relativePath,
        Status = MaterializationStatus.Blocked,
        Reason = GetLatestCheckoutPolicy.DocumentOpenReason,
        ManifestAction = MaterializationManifestAction.PreserveEntry,
    };

    private static MaterializationEntryResult LocalFileAppeared(MaterializationEntryResult baseResult, string relativePath) => baseResult with
    {
        RelativePath = relativePath,
        Status = MaterializationStatus.Blocked,
        Reason = GetLatestCheckoutPolicy.LocalFileAppearedReason,
        ManifestAction = MaterializationManifestAction.PreserveEntry,
    };

    private static MaterializationEntryResult NotWritable(MaterializationEntryResult baseResult, string relativePath) => baseResult with
    {
        RelativePath = relativePath,
        Status = MaterializationStatus.Failed,
        Reason = GetLatestCheckoutPolicy.NotWritableReason,
        ManifestAction = MaterializationManifestAction.PreserveEntry,
    };

    /// <summary>
    /// Replaces the base of a stale checkout without ever overwriting a file. The
    /// original is pinned where it stands, so from then on nobody can change or
    /// swap it, and every later step acts on that object: it is hashed, renamed
    /// aside into the proven <c>.arch\.recovery</c> and, if anything goes wrong,
    /// renamed back, all through the one handle. The new version takes the path
    /// create-new, so a file saved there meanwhile survives. A record written
    /// before the original moves lets <see cref="RecoverInterruptedReplacements"/>
    /// find it if this process never finishes.
    /// </summary>
    /// <returns>The result to report if the file was not replaced; otherwise, the
    ///  recovery copy left behind, if any.</returns>
    private async Task<(MaterializationEntryResult? Refused, string? RetainedCopy)> ReplaceStaleBaseAsync(
        string stagedPath,
        string absolutePath,
        string root,
        WorkspaceCheckoutBinding marker,
        WorkspacePlanEntry entry,
        MaterializationEntryResult baseResult,
        string relativePath,
        string stagingDir,
        IContentDownloader downloader,
        CancellationToken ct)
    {
        if (!IsSafeToChange(absolutePath))
        {
            return (DocumentOpen(baseResult, relativePath), null);
        }

        using var recovery = _openRecovery(root, true);
        if (recovery is null)
        {
            return (baseResult with
            {
                RelativePath = relativePath,
                Status = MaterializationStatus.Blocked,
                Reason = GetLatestCheckoutPolicy.RecoveryFolderUnsafeReason,
                ManifestAction = MaterializationManifestAction.PreserveEntry,
            }, null);
        }

        if (WorkspaceRecoveryFolder.TryReadFileIdentity(absolutePath) is null)
        {
            return (baseResult with
            {
                RelativePath = relativePath,
                Status = MaterializationStatus.Blocked,
                Reason = GetLatestCheckoutPolicy.FileIdentityReason,
                ManifestAction = MaterializationManifestAction.PreserveEntry,
            }, null);
        }

        using var original = PinnedRecoveryCopy.TryOpen(absolutePath);
        if (original is null)
        {
            return (DocumentOpen(baseResult, relativePath), null);
        }
        var held = await HashAsync(original.Content, ct).ConfigureAwait(false);
        if (!IsBaseOf(held, marker))
        {
            return (StaleConflict(baseResult, relativePath), null);
        }

        var operationId = Guid.NewGuid().ToString("N");
        var pending = new PendingReplacement
        {
            Schema = PendingReplacement.SchemaId,
            OperationId = operationId,
            RelativePath = relativePath,
            CadDocumentId = entry.CadDocumentId,
            CheckoutId = marker.CheckoutId,
            AsideFileName = PendingReplacement.AsideNameFor(Path.GetFileName(absolutePath), operationId),
            BaseChecksum = marker.BaseChecksum,
            BaseFileSize = marker.BaseFileSize,
            PlanChecksum = entry.Version!.Checksum,
            PlanFileSize = entry.Version.FileSize,
            FileVolumeSerial = original.Identity.VolumeSerial,
            FileIndex = original.Identity.FileIndex,
        };
        var asidePath = recovery.AsidePathFor(pending);
        var journalPath = recovery.JournalPathFor(pending);
        recovery.WriteJournal(journalPath, pending);
        if (!original.TryRenameTo(asidePath))
        {
            TryDelete(journalPath);
            return (baseResult with
            {
                RelativePath = relativePath,
                Status = MaterializationStatus.Failed,
                Reason = "Could not replace the local file: it could not be moved aside",
                ManifestAction = MaterializationManifestAction.PreserveEntry,
            }, null);
        }

        MaterializationEntryResult Conflict() => baseResult with
        {
            RelativePath = relativePath,
            Status = MaterializationStatus.Blocked,
            Reason = GetLatestCheckoutPolicy.ReplacementConflictReason(Path.GetRelativePath(root, asidePath)),
            ManifestAction = MaterializationManifestAction.PreserveEntry,
        };

        bool PutBack()
        {
            if (!original.TryRenameTo(absolutePath))
            {
                return false;
            }
            // Back where it was; a record that stays is settled by the next run.
            recovery.TryRemoveRecordOfAbsentCopy(journalPath, asidePath, _whileClearingRecord);
            return true;
        }

        try
        {
            if (!IsSafeToChange(absolutePath))
            {
                return (PutBack() ? DocumentOpen(baseResult, relativePath) : Conflict(), null);
            }
            ct.ThrowIfCancellationRequested();
            _promoteFile(stagedPath, absolutePath);
        }
        catch (OperationCanceledException)
        {
            if (PutBack())
            {
                throw;
            }
            return (Conflict(), null);
        }
        catch (Exception ex)
        {
            return (PutBack()
                ? baseResult with
                {
                    RelativePath = relativePath,
                    Status = MaterializationStatus.Failed,
                    Reason = $"Could not replace the local file: {ex.GetType().Name}",
                    ManifestAction = MaterializationManifestAction.PreserveEntry,
                }
                : Conflict(), null);
        }

        // The hash above matched the workspace's own records, which prove
        // nothing. The copy goes only if the SERVER still holds these exact bytes;
        // otherwise it stays with its record, and this run and the next say so.
        if (await ServerHoldsAsync(marker.BaseFileVersionId, held, stagingDir, downloader, ct).ConfigureAwait(false)
            && _deleteCopy(original))
        {
            original.Dispose();
            if (WorkspaceRecoveryFolder.ProbeCopy(asidePath, _readCopyAttributes) == RecoveryCopyPresence.Absent
                && recovery.TryRemoveRecordOfAbsentCopy(journalPath, asidePath, _whileClearingRecord))
            {
                return (null, null);
            }
        }
        return (null, Path.GetRelativePath(root, asidePath));
    }

    /// <summary>Evidence from outside the workspace: this version's bytes, as the
    ///  server serves them now, are exactly these. Any doubt is a no.</summary>
    private static async Task<bool> ServerHoldsAsync(
        string fileVersionId, (string Sha256, long Size) bytes, string stagingDir, IContentDownloader downloader, CancellationToken ct)
    {
        if (!WorkspaceManifest.IsWellFormedId(fileVersionId))
        {
            return false;
        }
        try
        {
            var (path, sha256, size) = await StageDownloadAsync(
                stagingDir, downloader, $"/api/file-versions/{Uri.EscapeDataString(fileVersionId)}/content", bytes.Size, ct).ConfigureAwait(false);
            TryDelete(path);
            return sha256 == bytes.Sha256 && size == bytes.Size;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// <summary>
    /// P6 M4.4 Package C: run before a Get Latest does anything else, under its
    /// exclusive workspace lock. Each record left by a replacement that never
    /// finished is settled from what is actually on disk: copy proven gone - done
    /// or taken care of; path empty and the manifest still holding the checkout -
    /// the original goes back, as the same object. Anything else needs a person,
    /// so the run stops and names what it found. Nothing here ever deletes a
    /// copy: only the workspace vouches for it at this point, and that is not
    /// evidence its bytes exist anywhere else. CONTRACT: this acts on what
    /// <paramref name="manifest"/> says, so the caller must already have validated
    /// that manifest's binding, as <see cref="GetLatestOrchestrator"/> does.
    /// </summary>
    /// <param name="manifest">The workspace's own record, read before this.</param>
    /// <exception cref="WorkspaceRootException">Something could not be settled.
    ///  Nothing was changed for that record.</exception>
    public void RecoverInterruptedReplacements(string workspaceRoot, WorkspaceManifest manifest, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        var root = Path.GetFullPath(workspaceRoot);
        if (!WorkspaceRecoveryFolder.Exists(root))
        {
            return;
        }
        using var recovery = _openRecovery(root, false)
            ?? throw new WorkspaceRootException(GetLatestCheckoutPolicy.RecoveryFolderUnsafeMessage);

        foreach (var journalPath in recovery.JournalPaths())
        {
            ct.ThrowIfCancellationRequested();
            var pending = recovery.TryReadJournal(journalPath, root)
                ?? throw Untrusted(root, journalPath);
            Settle(recovery, pending, journalPath, recovery.AsidePathFor(pending), root, manifest);
        }
    }

    private static WorkspaceRootException Untrusted(string root, string journalPath) =>
        new(GetLatestCheckoutPolicy.UntrustedRecoveryRecordMessage(Path.GetRelativePath(root, journalPath)));

    private void Settle(WorkspaceRecoveryFolder recovery, PendingReplacement pending, string journalPath, string asidePath, string root, WorkspaceManifest manifest)
    {
        switch (WorkspaceRecoveryFolder.ProbeCopy(asidePath, _readCopyAttributes))
        {
            case RecoveryCopyPresence.Absent when recovery.TryRemoveRecordOfAbsentCopy(journalPath, asidePath, _whileClearingRecord):
                return;
            case RecoveryCopyPresence.Absent or RecoveryCopyPresence.Unknown:
                throw new WorkspaceRootException(GetLatestCheckoutPolicy.RecoveryCopyUnknownMessage(
                    Path.GetRelativePath(root, asidePath), Path.GetRelativePath(root, journalPath)));
        }
        var entry = manifest.FindByRelativePath(pending.RelativePath);
        if (!pending.IsVouchedForBy(entry))
        {
            throw Untrusted(root, journalPath);
        }

        var refusal = new WorkspaceRootException(GetLatestCheckoutPolicy.InterruptedReplacementMessage(
            Path.GetRelativePath(root, asidePath), Path.GetRelativePath(root, journalPath)));
        var absolutePath = SafeWorkspacePath.ResolveWithinRoot(root, pending.RelativePath);
        if (entry!.Checkout is null || File.Exists(absolutePath))
        {
            throw refusal;
        }
        try
        {
            using var copy = PinnedRecoveryCopy.TryOpen(asidePath);
            if (copy is null
                || copy.Identity != pending.Identity
                || !IsSafeToChange(absolutePath)
                || !copy.TryRenameTo(absolutePath))
            {
                throw refusal;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw refusal;
        }
        // Restored; a record that stays is settled by the next run.
        recovery.TryRemoveRecordOfAbsentCopy(journalPath, asidePath, _whileClearingRecord);
    }

    /// <summary>The run's staging folder: proven and pinned on first use, inside
    ///  the <c>.arch</c> the run holds, so one run never writes through anything
    ///  but the real folder. No lease means <c>.arch</c> was refused.</summary>
    private sealed class StagingArea(string root, ArchFolderLease? arch) : IDisposable
    {
        private PinnedWorkspaceFolder? _folder;
        private bool _opened;

        public string? Path
        {
            get
            {
                if (!_opened)
                {
                    _opened = true;
                    _folder = Open();
                }
                return _folder?.Path;
            }
        }

        private PinnedWorkspaceFolder? Open()
        {
            return arch is not null && arch.TryHold()
                ? PinnedWorkspaceFolder.TryOpen(root, ".staging", create: true)
                : null;
        }

        public void Dispose() => _folder?.Dispose();
    }

    private static async Task<(string Sha256, long Size)> HashFileAsync(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return await HashAsync(stream, ct).ConfigureAwait(false);
    }

    private static async Task<(string Sha256, long Size)> HashAsync(Stream stream, CancellationToken ct)
    {
        using var sha = SHA256.Create();
        var hash = await sha.ComputeHashAsync(stream, ct).ConfigureAwait(false);
        return (Convert.ToHexString(hash).ToLowerInvariant(), stream.Length);
    }

    private static HashSet<string> FindCollidingCadDocumentIds(WorkspacePlan plan, string root)
    {
        var owners = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in plan.Entries)
        {
            if (!entry.CanMaterialize) continue;
            try
            {
                var abs = SafeWorkspacePath.ResolveWithinRoot(root, entry.Placement.GeneratedRelativePath);
                var key = abs.ToLowerInvariant();
                if (!owners.TryGetValue(key, out var list)) { list = []; owners[key] = list; }
                list.Add(entry.CadDocumentId);
            }
            catch
            {
                // reported again inside MaterializeEntryAsync
            }
        }
        var colliding = new HashSet<string>(StringComparer.Ordinal);
        foreach (var list in owners.Values)
        {
            if (list.Count > 1)
            {
                foreach (var id in list) colliding.Add(id);
            }
        }
        return colliding;
    }

    private static MaterializationEntryResult Base(WorkspacePlanEntry entry) => new()
    {
        CadDocumentId = entry.CadDocumentId,
        FileVersionId = entry.Version?.FileVersionId,
        RelativePath = null,
        Status = MaterializationStatus.Blocked,
        IsRoot = entry.IsRoot,
        DocumentNumber = entry.DocumentNumber,
    };

    private static string DescribeDownloadError(Exception ex) => ex switch
    {
        ContentDownloadTimeoutException => "the transfer timed out",
        ContentDownloadRedirectException => "the download was redirected (refused)",
        ContentDownloadHttpException h => $"HTTP {h.Status}",
        UnsafeContentPathException => "an unexpected content path (refused)",
        DownloadTooLargeException => "the response exceeded the expected size",
        _ => ex.GetType().Name,
    };

    /// <summary>Best-effort removal of a staged temp file. Swallows EVERY
    ///  failure - it runs in `finally` blocks and must never mask the original
    ///  download / integrity error, nor throw from a cleanup path.</summary>
    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* best effort - never let a cleanup failure surface */ }
    }
}

public sealed class DownloadTooLargeException(long maxBytes)
    : Exception($"Downloaded content exceeds the expected size of {maxBytes} bytes.");
