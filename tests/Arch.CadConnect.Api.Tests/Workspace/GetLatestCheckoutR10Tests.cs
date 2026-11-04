using System.Net;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R10: a bound file with no marker is never treated as
///  controlled until the server has said it is not this user's checkout, no entry
///  proceeds on silence, and a direct run holds the workspace lock throughout.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private static string[] StatusRequests(FakeHttpHandler handler) => handler.Requests
        .Where(r => r.RequestUri!.AbsolutePath.EndsWith("/checkout", StringComparison.Ordinal))
        .Select(r => r.RequestUri!.AbsolutePath)
        .ToArray();

    private async Task BoundPartWithNoMarker() => await Run(Server(RootPart), "PRT-1");

    // ---- a bound file with no marker ------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_writable_file_the_server_says_is_mine_is_not_set_read_only()
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);
        var entry = JsonOf(Entry(PartPath));

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart)), "PRT-1");

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Contains("Checkout", result.Reason);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
        Assert.False(report.ReachedValidState);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_read_only_file_the_server_says_is_mine_is_reported_and_not_called_current()
    {
        await BoundPartWithNoMarker();

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart)), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.False(report.ReachedValidState);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_edited_file_the_server_says_is_mine_keeps_its_bytes_and_its_entry()
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        var entry = JsonOf(Entry(PartPath));

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart)), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_missing_file_the_server_says_is_mine_is_not_recreated()
    {
        await BoundPartWithNoMarker();
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart)), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.False(File.Exists(PartPath));
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError, """{"error":"down"}""")]
    [InlineData(HttpStatusCode.NotFound, """{"error":"gone"}""")]
    [InlineData(HttpStatusCode.OK, """{"state":"something-new"}""")]
    [InlineData(HttpStatusCode.OK, """{"state":"available","checkout":{"id":"co_1","cadDocumentId":"cad_part"}}""")]
    [Trait("PackageC", "Policy")]
    public async Task A_status_with_no_usable_answer_changes_nothing(HttpStatusCode code, string body)
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        var entry = JsonOf(Entry(PartPath));

        var report = await Run(ServerAnswering(RootPart, body, code), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
    }

    [Theory]
    [InlineData(AvailableJson)]
    [InlineData(LockedJson)]
    [Trait("PackageC", "Policy")]
    public async Task A_file_that_is_not_mine_follows_the_ordinary_rules(string answer)
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);

        var report = await Run(ServerAnswering(RootPart, answer), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_edited_file_that_is_not_mine_stays_a_local_conflict_and_loses_its_verified_state()
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);
        await File.WriteAllBytesAsync(PartPath, EditedBytes);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(WorkspaceManifestEntryState.Unverified, Entry(PartPath).State);
    }

    // ---- an unbound path with nothing on it -----------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_new_workspace_downloads_without_asking_about_checkouts()
    {
        var handler = Server(RootPart);

        var report = await Run(handler, "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Empty(StatusRequests(handler));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_that_appears_at_an_unbound_path_during_the_download_is_kept()
    {
        var handler = Server([RootPart], content: d =>
        {
            File.WriteAllBytes(PartPath, EditedBytes);
            return Content(d);
        });

        var report = await Run(handler, "PRT-1");

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_document_at_a_free_path_is_still_adopted_and_a_taken_one_still_refused()
    {
        await BoundPartWithNoMarker();
        var moved = RootPart with { Id = "cad_other", Number = "OTH-1", Fv = "fv_other", Bytes = NewPartBytes };

        var taken = await Run(Server(moved), "OTH-1");

        Assert.Equal(MaterializationStatus.Blocked, taken.Results.Single().Status);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
    }

    // ---- a run that stopped asking ---------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_entry_past_the_deadline_is_blocked_and_the_run_is_not_reported_as_current()
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);
        var entry = JsonOf(Entry(PartPath));

        var report = await Run(Server(RootPart), "PRT-1", statusDeadline: TimeSpan.Zero);

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Contains("not-checked", result.Reason);
        Assert.False(report.ReachedValidState);
        Assert.Contains("not checked", report.ToSummaryLine());
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_during_reconciliation_stops_the_run_before_anything_is_materialized()
    {
        await BoundPartWithNoMarker();
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);
        using var cancel = new CancellationTokenSource();
        var handler = Server([RootPart], _ =>
        {
            cancel.Cancel();
            return Available;
        });

        await Assert.ThrowsAnyAsync<Exception>(() => Run(handler, "PRT-1", ct: cancel.Token));

        Assert.False(File.Exists(PartPath));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task With_no_status_client_a_bound_file_is_blocked_not_assumed()
    {
        await BoundPartWithNoMarker();

        var report = await Run(Server(RootPart), "PRT-1", withStatusClient: false);

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Decisions_with_an_entry_missing_block_that_entry()
    {
        var http = new HttpClient(Server(RootPart));
        var session = WorkspaceTestSession.Make();
        var plan = await new WorkspacePlanClient(WorkspaceTestSession.Server, session, http, TimeSpan.FromSeconds(5)).FetchAsync(RootPart.Id);

        var report = await new WorkspaceMaterializer(NoEditorProbe.Instance).MaterializeAsync(
            plan, _root, new HttpContentDownloader(WorkspaceTestSession.Server, session, http), decisions: new Dictionary<string, GetLatestEntryDecision>());

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Contains("decision-missing", result.Reason);
        Assert.False(File.Exists(PartPath));
    }

    // ---- a direct run holds the workspace lock from start to save --------------------

    private bool WorkspaceLockIsHeld()
    {
        try
        {
            using var attempt = new FileStream(Path.Combine(_root, ".arch", "locks", "workspace.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.Read);
            return false;
        }
        catch (IOException)
        {
            return true;
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_run_holds_the_workspace_lock_through_download_and_save()
    {
        var duringDownload = false;
        var duringSave = false;

        await Run(Server([RootPart], content: d =>
        {
            duringDownload = WorkspaceLockIsHeld();
            return Content(d);
        }), "PRT-1", clock: OnRecording(() => duringSave = WorkspaceLockIsHeld()));

        Assert.True(duringDownload);
        Assert.True(duringSave);
        Assert.False(WorkspaceLockIsHeld());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_command_holding_the_lock_runs_Get_Latest_without_refusing_itself()
    {
        var gate = new Arch.CadConnect.Core.Workspace.Locking.CommandLockGate(
            new Arch.CadConnect.Core.Workspace.Locking.WorkspaceLockAcquirer(
                Arch.CadConnect.Core.Workspace.Locking.WindowsLockPathSystem.Instance,
                Arch.CadConnect.Core.Workspace.Locking.WindowsLockHandleFactory.Instance),
            null);
        var held = gate.Admit(Arch.CadConnect.Core.Workspace.Locking.WorkspaceLockRequest.ForGetLatest("Get Latest", _root), () => true).Lock!;
        MaterializationReport? report = null;

        await held.RunAsync(async _ => report = await Run(Server(RootPart), "PRT-1"), CancellationToken.None);

        Assert.Equal(MaterializationStatus.Downloaded, report!.Results.Single().Status);
        Assert.True(held.IsReleased);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_workspace_lock_someone_else_holds_refuses_a_direct_run_with_nothing_sent()
    {
        var holder = new Arch.CadConnect.Core.Workspace.Locking.WorkspaceLockAcquirer(
            Arch.CadConnect.Core.Workspace.Locking.WindowsLockPathSystem.Instance,
            Arch.CadConnect.Core.Workspace.Locking.WindowsLockHandleFactory.Instance)
            .TryAcquire(Arch.CadConnect.Core.Workspace.Locking.WorkspaceLockRequest.ForGetLatest("Another Inventor", _root)).Lease!;
        var handler = Server(RootPart);
        try
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));
        }
        finally
        {
            holder.Dispose();
        }

        Assert.Empty(handler.Requests);
    }
    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_run_into_a_folder_that_does_not_exist_takes_its_lock_before_its_lease_and_saves()
    {
        Directory.Delete(_root, recursive: true);

        var report = await Run(Server(RootPart), "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(WorkspaceManifestLoadStatus.Loaded, WorkspaceManifest.Load(_root).Status);
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(_root).Status);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_that_changes_before_materialization_stops_the_run_before_any_download()
    {
        var handler = Server([RootPart], onPlan: () => File.WriteAllText(ManifestPath, ForeignManifest));

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.False(File.Exists(PartPath));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
    }
}
