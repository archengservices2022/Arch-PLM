using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Linq;

using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Api.Workspace;

/// <summary>What only a test may change about a run.</summary>
/// <param name="SaveManifest">Replaces saving the manifest.</param>
/// <param name="StatusDeadline">Replaces the status reconciliation deadline.</param>
/// <param name="OnArchLease">Runs with the workspace root just after the run's
///  <c>.arch</c> lease is taken.</param>
/// <param name="Reconciler">Seams of the status reconciliation.</param>
internal sealed record GetLatestTestHooks(
    Func<WorkspaceManifest, string?>? SaveManifest = null,
    TimeSpan? StatusDeadline = null,
    Action<string>? OnArchLease = null,
    CheckoutStatusReconcilerHooks? Reconciler = null);

/// <summary>
/// Runs the full Get Latest protocol once, end to end - the C# equivalent of
/// <c>web/cli/orchestrate-workspace-get.ts</c> plus the P4B identity binding:
///
///   resolve (documentNumber -> stable cadDocumentId)
///     -> fetch + validate the workspace plan (refuse an unsafe plan wholesale)
///     -> refuse any entry that would land inside another workspace (M4.4)
///     -> ask the server about every checkout marker in the plan, every bound
///        file without one, and every existing file no manifest entry describes,
///        so no entry proceeds on silence (Package C)
///     -> materialize (staged, size + SHA-256 verified, never overwriting)
///     -> update the workspace manifest ATOMICALLY, only for what was verified
///     -> return a MaterializationReport
///
/// The manifest (`.arch\workspace.json`) is touched ONLY after materialization
/// completes; if the plan was refused or materialization threw, the manifest
/// is left exactly as it was (PM control 1). P6 M4.4 Package C: an existing
/// manifest that cannot be read refuses the whole run before its first request,
/// the exclusive workspace lock keeps every marker stable from the status request
/// to the manifest write, and a run cancelled part-way records the entries it
/// finished. The lock is the command's if this runs inside one, and taken here
/// otherwise, always BEFORE the <c>.arch</c> lease: taking it is what first
/// creates <c>.arch</c> in a new workspace.
/// </summary>
public sealed class GetLatestOrchestrator
{
    private readonly ArchServerUri _server;
    private readonly Func<IArchSession, WorkspacePlanClient> _planClientFactory;
    private readonly Func<IArchSession, IContentDownloader> _downloaderFactory;
    private readonly Func<IArchSession, CadDocumentLookup, CancellationToken, Task<ResolvedCadDocument>> _resolve;
    private readonly WorkspaceMaterializer _materializer;
    private readonly Func<DateTimeOffset> _clock;
    private readonly Func<string, string?> _findRootForFile;
    private readonly Func<WorkspaceManifest, string?> _saveManifest;
    private readonly TimeSpan _statusDeadline;
    private readonly Action<string>? _onArchLease;
    private readonly CheckoutStatusReconcilerHooks? _reconcilerHooks;
    private readonly Func<IArchSession, string, CancellationToken, Task<ServerCheckoutStatus>>? _checkoutStatus;

    public GetLatestOrchestrator(
        ArchServerUri server,
        Func<IArchSession, CadDocumentLookup, CancellationToken, Task<ResolvedCadDocument>> resolve,
        Func<IArchSession, WorkspacePlanClient>? planClientFactory = null,
        Func<IArchSession, IContentDownloader>? downloaderFactory = null,
        WorkspaceMaterializer? materializer = null,
        Func<DateTimeOffset>? clock = null,
        Func<string, string?>? findRootForFile = null,
        Func<IArchSession, string, CancellationToken, Task<ServerCheckoutStatus>>? checkoutStatus = null)
        : this(new GetLatestTestHooks(), server, resolve, planClientFactory, downloaderFactory, materializer, clock, findRootForFile, checkoutStatus)
    {
    }

    internal GetLatestOrchestrator(
        GetLatestTestHooks hooks,
        ArchServerUri server,
        Func<IArchSession, CadDocumentLookup, CancellationToken, Task<ResolvedCadDocument>> resolve,
        Func<IArchSession, WorkspacePlanClient>? planClientFactory = null,
        Func<IArchSession, IContentDownloader>? downloaderFactory = null,
        WorkspaceMaterializer? materializer = null,
        Func<DateTimeOffset>? clock = null,
        Func<string, string?>? findRootForFile = null,
        Func<IArchSession, string, CancellationToken, Task<ServerCheckoutStatus>>? checkoutStatus = null)
    {
        _saveManifest = hooks.SaveManifest ?? (manifest => manifest.SaveIfUnchangedSinceLoad());
        _statusDeadline = hooks.StatusDeadline ?? CheckoutStatusReconciler.DefaultDeadline;
        _onArchLease = hooks.OnArchLease;
        _reconcilerHooks = hooks.Reconciler;
        _findRootForFile = findRootForFile ?? WorkspaceRootLocator.FindRootForFile;
        _checkoutStatus = checkoutStatus;
        _server = server ?? throw new ArgumentNullException(nameof(server));
        _resolve = resolve ?? throw new ArgumentNullException(nameof(resolve));
        _planClientFactory = planClientFactory ?? (s => WorkspacePlanClient.Create(_server, s));
        _downloaderFactory = downloaderFactory ?? (s => HttpContentDownloader.Create(_server, s));
        _materializer = materializer ?? new WorkspaceMaterializer();
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
    }

    public async Task<MaterializationReport> RunAsync(
        IArchSession session,
        GetLatestRequest request,
        CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(session);
        ArgumentNullException.ThrowIfNull(request);
        SafeWorkspacePath.RequireAbsoluteRoot(request.WorkspaceRoot);

        // R10 correction (MAJOR 1): every request below goes to this orchestrator's
        // server with this session's credentials. Checked first - before the
        // ambient command is even looked at, so a refusal neither takes nor spends
        // anyone's admission, and before any lock, recovery or request.
        RequireSameServer(_server, session);

        return await WorkspaceCommandScope.RunAsync(
            WorkspaceLockRequest.ForGetLatest("Get Latest", request.WorkspaceRoot),
            () =>
            {
                RequireSameServer(_server, session);
                RequireTarget(session, request.WorkspaceRoot);
            },
            () => RunLockedAsync(session, request, ct),
            refusal => new WorkspaceRootException(WorkspaceLockMessages.Describe(refusal))).ConfigureAwait(false);
    }

    internal const string OtherServerMessage =
        "Refusing to send this session's credentials to a different server. Nothing was sent or changed.";

    /// <summary>R10 correction (MAJOR 1): the server requests go to must be the one
    ///  the session signed in to.</summary>
    internal static void RequireSameServer(ArchServerUri server, IArchSession session)
    {
        if (!server.MatchesOrigin(session.Server.Origin))
        {
            throw new WorkspaceRootException(OtherServerMessage);
        }
    }

    /// <summary>Before any lock, and again under it. An unreadable manifest is
    ///  left to the run itself, which has the better words for it.</summary>
    private static void RequireTarget(IArchSession session, string workspaceRoot)
    {
        var target = WorkspaceServerBinding.CheckGetLatestTarget(workspaceRoot, session.Server, session.Identity.OrganizationId);
        if (!target.Allowed && target.Verdict != WorkspaceServerBindingVerdict.ManifestUnreadable)
        {
            throw new WorkspaceRootException(target.Message);
        }
    }

    private async Task<MaterializationReport> RunLockedAsync(IArchSession session, GetLatestRequest request, CancellationToken ct)
    {
        // 0-. P6 M4.4 Package C: everything below reads or writes .arch, so one
        //     lease holds it from here through the manifest save. A new workspace
        //     has none yet: this run must be the one that creates it.
        using var arch = ArchFolderLease.TryBegin(request.WorkspaceRoot)
            ?? throw new WorkspaceRootException(GetLatestCheckoutPolicy.ArchFolderUnsafeMessage);
        _onArchLease?.Invoke(request.WorkspaceRoot);

        // 0--. P6 M4.4 Package C: a save that did not end cleanly is for a person
        //      to resolve. Nothing here reads, moves or promotes what it left.
        var recovery = WorkspaceRecoveryState.Inspect(request.WorkspaceRoot);
        if (recovery.IsRecoveryRequired)
        {
            throw new WorkspaceRootException(GetLatestCheckoutPolicy.RecoveryRequiredMessage(recovery.Artifacts));
        }
        // 0. P6 M4.4 Package C: an unreadable manifest may hold checkouts and
        //    bindings nothing else records - refuse rather than rebuild it.
        var (manifest, manifestStatus) = WorkspaceManifest.Load(request.WorkspaceRoot);
        // (A missing manifest loads empty: every existing file is simply unbound.)
        if (manifestStatus == WorkspaceManifestLoadStatus.Invalid || !manifest.HasSoundEntries())
        {
            throw new WorkspaceRootException(
                "Get Latest was not run: this workspace's record (.arch\\workspace.json) could not be read. "
                + "Nothing was changed. Close anything using it, or repair or restore it, and try again.");
        }

        // 0a. P6 M4.4 Package C: the record just read, under the lease, against
        //     the session this run was given. The connection manager checked
        //     before this, but it read another moment's file, and a direct caller
        //     has no connection manager. This comes before the recovery records,
        //     which act on this record, and before the first request.
        if (manifestStatus == WorkspaceManifestLoadStatus.Loaded)
        {
            var binding = WorkspaceServerBinding.Evaluate(
                manifest.ServerOrigin, session.Server, request.WorkspaceRoot, manifest.OrganizationId, session.Identity.OrganizationId);
            if (!binding.Allowed)
            {
                throw new WorkspaceRootException(binding.Message);
            }
        }

        // 0b. P6 M4.4 Package C: finish or surface any replacement an earlier
        //     run left behind, before this run looks at a single file.
        _materializer.RecoverInterruptedReplacements(request.WorkspaceRoot, manifest, ct);

        // 1. resolve the explicit selection to an authoritative id.
        var resolved = await _resolve(session, request.Root, ct).ConfigureAwait(false);

        // 2. fetch + validate the version-pinned plan (throws on unsafe).
        var planClient = _planClientFactory(session);
        var plan = await planClient.FetchAsync(resolved.CadDocumentId, ct).ConfigureAwait(false);

        // 2b. P6 M4.4: refuse, BEFORE any download, a plan any of whose
        //     entries would land inside a DIFFERENT workspace (nested roots).
        var nested = GetLatestNestingCheck.FindNestedEntries(plan, request.WorkspaceRoot, _findRootForFile);
        if (nested.Count > 0)
        {
            throw new UnsafeWorkspacePlanException(nested);
        }

        // 2c. P6 M4.4 Package C: what each entry may do to its file and marker.
        var decisions = await DecideEntriesAsync(session, plan, request.WorkspaceRoot, manifest, ct).ConfigureAwait(false);

        // The caller's cancellation outranks a deadline or a breaker that fired
        // at the same moment: nothing was decided, and nothing is materialized.
        ct.ThrowIfCancellationRequested();

        // 2d. P6 M4.4 Package C: this run has been talking to the server since it
        //     read the record. Nothing is started on a record that has moved. The
        //     object loaded above stays the one everything uses, up to the save.
        var moved = WorkspaceRecoveryState.Inspect(request.WorkspaceRoot);
        if (moved.IsRecoveryRequired)
        {
            throw new WorkspaceRootException(GetLatestCheckoutPolicy.RecoveryRequiredMessage(moved.Artifacts));
        }
        if (!manifest.IsUnchangedOnDisk())
        {
            throw new WorkspaceRootException(GetLatestCheckoutPolicy.ManifestChangedBeforeWorkMessage);
        }

        // 3. materialize (per-entry verified downloads; never overwrites).
        var downloader = _downloaderFactory(session);
        var context = new WorkspaceManifestRunContext(
            ServerOrigin: _server.OriginString,
            OrganizationId: session.Identity.OrganizationId,
            OrganizationCode: session.Identity.OrganizationCode,
            RootCadDocumentId: resolved.CadDocumentId,
            RootDocumentNumber: resolved.DocumentNumber);

        MaterializationReport report;
        try
        {
            report = await _materializer
                .MaterializeAsync(plan, request.WorkspaceRoot, downloader, ct, _clock, decisions, arch)
                .ConfigureAwait(false);
        }
        catch (MaterializationCanceledException canceled)
        {
            // P6 M4.4 Package C: what the run finished before it was cancelled
            // is on disk, so the manifest has to say so.
            var recorded = ChangedLocalState(canceled.Completed)
                ? Record(manifest, canceled.Completed, plan, context, arch)
                : canceled.Completed;

            // A copy left behind outranks the cancellation: the user has to be
            // told where it is.
            var left = recorded.Results
                .Where(r => GetLatestCheckoutPolicy.IsReplacementConflict(r.Reason) || r.RetainedRecoveryCopy is not null)
                .Select(r => r.Reason)
                .ToList();
            if (recorded.RetainedManifestArtifact is { } artifact)
            {
                left.Add(GetLatestCheckoutPolicy.ManifestArtifactRetainedReason(artifact));
            }
            if (left.Count > 0)
            {
                throw new WorkspaceRootException(
                    string.Join(" ", left),
                    recorded.Results.Count(r => r.RetainedRecoveryCopy is not null),
                    recorded.RetainedManifestArtifact is null ? 0 : 1);
            }
            throw;
        }

        // Every entry left as it was: nothing to record, not even a new root.
        if (report.Results.Count > 0
            && report.Results.All(r => r.ManifestAction == MaterializationManifestAction.PreserveEntry))
        {
            return report;
        }

        // 4. update the manifest ATOMICALLY, AFTER a completed run. Only
        //    verified (Downloaded / AlreadyCurrent) entries claim currency.
        return Record(manifest, report, plan, context, arch);
    }

    /// <returns>The report, carrying anything the save left behind.</returns>
    private MaterializationReport Record(
        WorkspaceManifest manifest, MaterializationReport report, WorkspacePlan plan, WorkspaceManifestRunContext context, ArchFolderLease arch)
    {
        try
        {
            manifest.ApplyRun(report, plan, context, _clock());

            // Held since the run began, or since this run created it; a run that
            // never needed it before creates it here.
            if (!arch.TryHold())
            {
                throw new WorkspaceManifestChangedException();
            }
            return _saveManifest(manifest) is { } retained ? report with { RetainedManifestArtifact = retained } : report;
        }
        catch (WorkspaceManifestChangedException ex)
        {
            throw Refused(GetLatestCheckoutPolicy.ManifestChangedMessage, report, ex.RetainedArtifact);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or WorkspaceManifestPersistException)
        {
            // Get Latest is non-destructive: the on-disk files are valid and
            // the manifest is rebuilt on the next successful run. (P4C's
            // state-changing operations do NOT swallow this - see
            // CheckoutOrchestrator.) P6 M4.4 Package C: neither may this run,
            // once it changed a file or a checkout the manifest must describe.
            var retained = (ex as WorkspaceManifestPersistException)?.RetainedArtifact;
            if (ChangedLocalState(report) || retained is not null)
            {
                throw Refused(
                    "Get Latest updated local files, but this workspace's record (.arch\\workspace.json) could not be saved. "
                    + "Close anything using it and run Get Latest again.", report, retained);
            }
            return report;
        }
    }

    /// <summary>An exception replaces the report, so what it would have said
    ///  about anything left behind goes with it.</summary>
    private static WorkspaceRootException Refused(string message, MaterializationReport report, string? retainedManifest)
    {
        var copies = report.Results.Where(r => r.RetainedRecoveryCopy is not null).Select(r => r.Reason).ToList();
        var parts = copies.Prepend(message);
        if (retainedManifest is not null)
        {
            parts = parts.Append(GetLatestCheckoutPolicy.ManifestArtifactRetainedReason(retainedManifest));
        }
        return new WorkspaceRootException(string.Join(" ", parts), copies.Count, retainedManifest is null ? 0 : 1);
    }

    private static bool ChangedLocalState(MaterializationReport report) =>
        report.Results.Any(r => r.Status == MaterializationStatus.Downloaded
            || r.ManifestAction is MaterializationManifestAction.KeepCheckout or MaterializationManifestAction.ClearCheckout);

    /// <summary>P6 M4.4 Package C: exactly one decision for EVERY materializable
    ///  entry, keyed by cadDocumentId, made only once every status request has
    ///  ended: a checkout marker in the plan, a bound file with none, and an
    ///  existing file no manifest entry describes all need the server. An entry the
    ///  run stopped asking about is Blocked, never waved through.</summary>
    private async Task<IReadOnlyDictionary<string, GetLatestEntryDecision>> DecideEntriesAsync(
        IArchSession session,
        WorkspacePlan plan,
        string workspaceRoot,
        WorkspaceManifest manifest,
        CancellationToken ct)
    {
        var decisions = new Dictionary<string, GetLatestEntryDecision>(StringComparer.Ordinal);
        var waiting = new List<(string CadDocumentId, Func<ServerCheckoutStatus?, GetLatestEntryDecision> Decide)>();

        foreach (var entry in plan.Entries)
        {
            if (!entry.CanMaterialize || entry.Version is null)
            {
                continue;
            }
            var bound = manifest.FindByRelativePath(entry.Placement.GeneratedRelativePath);
            if (bound is null)
            {
                if (ExistsLocally(workspaceRoot, entry))
                {
                    waiting.Add((entry.CadDocumentId, status => GetLatestCheckoutPolicy.DecideUnbound(status) ?? GetLatestEntryDecision.Proceed));
                }
                else
                {
                    // Nothing here to protect, and a copy of a document checked out
                    // elsewhere is exactly what a new folder is for.
                    decisions[entry.CadDocumentId] = GetLatestEntryDecision.ProceedNewFile;
                }
            }
            else if (!string.Equals(bound.CadDocumentId, entry.CadDocumentId, StringComparison.Ordinal))
            {
                decisions[entry.CadDocumentId] = bound.Checkout is null
                    ? GetLatestEntryDecision.AdoptIfPathFree
                    : GetLatestEntryDecision.Block(GetLatestCheckoutPolicy.PathConflictCheckedOutReason);
            }
            else if (bound.Checkout is { } marker)
            {
                waiting.Add((entry.CadDocumentId, status => GetLatestCheckoutPolicy.Decide(entry, marker, status)));
            }
            else
            {
                waiting.Add((entry.CadDocumentId, GetLatestCheckoutPolicy.DecideMarkerless));
            }
        }

        var outcomes = await AskServerAsync(session, waiting.Select(w => w.CadDocumentId).ToList(), ct).ConfigureAwait(false);
        foreach (var (cadDocumentId, decide) in waiting)
        {
            var outcome = outcomes[cadDocumentId];
            decisions[cadDocumentId] = outcome.NotAsked
                ? GetLatestEntryDecision.Block(GetLatestCheckoutPolicy.CheckoutStatusNotCheckedReason)
                : decide(outcome.Status);
        }
        return decisions;
    }

    /// <summary>No status client means no usable answer for anything.</summary>
    private async Task<IReadOnlyDictionary<string, CheckoutStatusOutcome>> AskServerAsync(
        IArchSession session, IReadOnlyList<string> cadDocumentIds, CancellationToken ct)
    {
        if (_checkoutStatus is not { } status)
        {
            return cadDocumentIds.ToDictionary(id => id, _ => new CheckoutStatusOutcome(null, NotAsked: false), StringComparer.Ordinal);
        }
        return await CheckoutStatusReconciler
            .RunAsync(cadDocumentIds, (id, token) => status(session, id, token), _statusDeadline, ct, _reconcilerHooks)
            .ConfigureAwait(false);
    }

    /// <summary>An unsafe path counts as absent: the materializer refuses it.</summary>
    private static bool ExistsLocally(string workspaceRoot, WorkspacePlanEntry entry)
    {
        try
        {
            return File.Exists(SafeWorkspacePath.ResolveWithinRoot(Path.GetFullPath(workspaceRoot), entry.Placement.GeneratedRelativePath));
        }
        catch (Exception ex) when (ex is UnsafeWorkspacePathException or WorkspaceRootException)
        {
            return false;
        }
    }

    /// <summary>The default resolve implementation over
    ///  <c>GET /api/desktop/cad-documents/resolve</c>. Used by
    ///  <c>ArchApiClient</c>; injectable for tests.</summary>
    public static async Task<ResolvedCadDocument> ResolveViaHttpAsync(
        ArchServerUri server,
        IArchSession session,
        HttpClient http,
        CadDocumentLookup lookup,
        TimeSpan timeout,
        CancellationToken ct)
    {
        var query = string.Join('&', lookup.BuildQueryParameters()
            .Select(p => $"{p.Name}={Uri.EscapeDataString(p.Value)}"));
        var url = server.ResolvePath($"/api/desktop/cad-documents/resolve?{query}");
        if (!server.MatchesOrigin(url))
        {
            throw new ArchApiException(ArchApiFailureKind.BadRequest, "Refusing to resolve against a different server.");
        }

        using var timeoutCts = new CancellationTokenSource(timeout);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token);

        HttpResponseMessage response;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Authorization = AuthenticationHeaderValue.Parse(session.AuthorizationHeaderValue());
            request.Headers.Accept.ParseAdd("application/json");
            response = await http.SendAsync(request, HttpCompletionOption.ResponseContentRead, linked.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            throw new ArchApiException(ArchApiFailureKind.Timeout, "The Arch PLM server did not respond in time.");
        }
        catch (HttpRequestException ex)
        {
            throw new ArchApiException(ArchApiFailureKind.Network,
                "Could not reach the Arch PLM server. Check the address and your network.",
                diagnostic: ex.GetType().Name, inner: ex);
        }

        using (response)
        {
            var body = await response.Content.ReadAsStringAsync(linked.Token).ConfigureAwait(false);

            if ((int)response.StatusCode is >= 300 and < 400)
            {
                throw new ArchApiException(ArchApiFailureKind.Server, "Arch PLM returned an unexpected response.", (int)response.StatusCode, "redirect");
            }

            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                throw new ArchApiException(ArchApiFailureKind.NotFound,
                    $"No CAD document matched \"{lookup.Value}\" in your organization.", 404);
            }
            if (response.StatusCode == HttpStatusCode.Unauthorized)
            {
                throw new ArchApiException(ArchApiFailureKind.Unauthorized, "Your session is not valid. Sign in again.", 401);
            }
            if (!response.IsSuccessStatusCode)
            {
                throw new ArchApiException(ArchApiFailureKind.Server, "Arch PLM returned an unexpected response.", (int)response.StatusCode);
            }

            ResolveDto? dto;
            try { dto = JsonSerializer.Deserialize<ResolveDto>(body, new JsonSerializerOptions(JsonSerializerDefaults.Web)); }
            catch (JsonException) { dto = null; }

            // Require the exact server contract AND every identity/display field
            // before this result is trusted. A missing / unsupported contract,
            // or an empty cadDocumentId / documentNumber / fileName / cadType,
            // fails here - BEFORE RunAsync fetches a plan, downloads a byte or
            // touches the manifest. Identity is cadDocumentId only; the other
            // fields are validated-present but never used as identity.
            if (dto is null
                || !DesktopCadDocumentContract.IsSupported(dto.Contract)
                || string.IsNullOrWhiteSpace(dto.CadDocumentId)
                || string.IsNullOrWhiteSpace(dto.DocumentNumber)
                || string.IsNullOrWhiteSpace(dto.FileName)
                || string.IsNullOrWhiteSpace(dto.CadType))
            {
                throw new ArchApiException(
                    ArchApiFailureKind.Server,
                    "Arch PLM returned an unexpected response.",
                    diagnostic: "resolve response failed contract check");
            }

            return new ResolvedCadDocument(dto.CadDocumentId, dto.DocumentNumber, dto.FileName, dto.CadType);
        }
    }

    private sealed record ResolveDto(
        string Contract = "",
        string CadDocumentId = "",
        string DocumentNumber = "",
        string FileName = "",
        string CadType = "");
}
