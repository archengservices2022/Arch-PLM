using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R9: Get Latest recovers nothing by itself. It reads
///  no interrupted workspace, and it validates the binding it read against the
///  session it was given before it touches a recovery record or the server.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private const string OperationId = "0123456789abcdef0123456789abcdef";

    private string SetAsidePath => $"{ManifestPath}.{OperationId}.previous";

    private void EditManifestRoot(Action<System.Text.Json.Nodes.JsonObject> edit)
    {
        var manifest = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(ManifestPath))!.AsObject();
        edit(manifest);
        File.WriteAllText(ManifestPath, manifest.ToJsonString());
    }

    private static void AssertNoServerRequest(FakeHttpHandler handler) => Assert.Empty(handler.Requests);

    private static Action<ManifestSaveStep> At(ManifestSaveStep when, Action act) => step =>
    {
        if (step == when)
        {
            act();
        }
    };

    private static Func<WorkspaceManifest, string?> CleanupRefused =>
        manifest => manifest.SaveIfUnchangedSinceLoad(deletePrevious: _ => false);

    // ---- nothing is promoted ---------------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_interrupted_with_the_path_empty_is_refused_and_nothing_is_promoted()
    {
        await CheckedOutPart();
        File.Move(ManifestPath, SetAsidePath);
        var before = await File.ReadAllBytesAsync(SetAsidePath);
        var handler = Server(RootPart);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Contains(Path.GetFileName(SetAsidePath), ex.Message);
        Assert.False(File.Exists(ManifestPath));
        Assert.Equal(before, await File.ReadAllBytesAsync(SetAsidePath));
        AssertNoServerRequest(handler);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_forged_candidate_is_preserved_and_never_read_as_authority()
    {
        await CheckedOutPart();
        File.Move(ManifestPath, ManifestPath + ".moved-by-hand");
        await File.WriteAllTextAsync(SetAsidePath, ForeignManifest);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.False(File.Exists(ManifestPath));
        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(SetAsidePath));
        AssertNoServerRequest(handler);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_interrupted_workspace_does_not_settle_its_recovery_records()
    {
        var captured = await InterruptedReplacement();
        File.Move(ManifestPath, SetAsidePath);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.True(File.Exists(CopyOf(captured)));
        Assert.True(File.Exists(JournalOf(captured)));
        Assert.False(File.Exists(PartPath));
    }

    // ---- the binding comes before recovery records and the server --------------------

    [Theory]
    [InlineData("serverOrigin", "http://localhost:3000")]
    [InlineData("organizationId", "org-of-someone-else")]
    [Trait("PackageC", "Policy")]
    public async Task A_wrong_binding_is_refused_before_a_recovery_record_or_the_server_is_touched(string field, string value)
    {
        var captured = await InterruptedReplacement();
        EditManifestRoot(manifest => manifest[field] = value);
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        AssertNoServerRequest(handler);
        Assert.True(File.Exists(CopyOf(captured)));
        Assert.True(File.Exists(JournalOf(captured)));
        Assert.False(File.Exists(PartPath));
        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_healthy_workspace_with_no_recorded_organization_keeps_working()
    {
        await CheckedOutPart();
        EditManifestRoot(manifest => manifest.Remove("organizationId"));

        var report = await Run(Server(RootPart), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.NotNull(Entry(PartPath).Checkout);
    }

    // ---- a direct caller of the API gets the same guards ----------------------------

    public static TheoryData<string> FileCommands => new() { "Checkout", "CheckIn", "UndoCheckout" };

    private static Task Direct(ArchApiClient api, string command, ManagedFileRef file) => command switch
    {
        "Checkout" => api.CheckoutAsync(WorkspaceTestSession.Make(), file),
        "CheckIn" => api.CheckInAsync(WorkspaceTestSession.Make(), file),
        _ => api.UndoCheckoutAsync(WorkspaceTestSession.Make(), file, reason: null),
    };

    [Theory]
    [MemberData(nameof(FileCommands))]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_file_command_on_an_interrupted_workspace_sends_nothing(string command)
    {
        await CheckedOutPart();
        File.Move(ManifestPath, SetAsidePath);
        var handler = Server(RootPart);
        var api = new ArchApiClient(WorkspaceTestSession.Server, new HttpClient(handler));

        await Assert.ThrowsAsync<ArchApiException>(() => Direct(api, command, ManagedFileRef.Create(_root, PartPath)));

        AssertNoServerRequest(handler);
    }

    [Theory]
    [MemberData(nameof(FileCommands))]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_file_command_for_another_organization_sends_nothing(string command)
    {
        await CheckedOutPart();
        EditManifestRoot(manifest => manifest["organizationId"] = "org-of-someone-else");
        var handler = Server(RootPart);
        var api = new ArchApiClient(WorkspaceTestSession.Server, new HttpClient(handler));

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => Direct(api, command, ManagedFileRef.Create(_root, PartPath)));

        Assert.Contains("organization", ex.Message);
        AssertNoServerRequest(handler);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_Get_Latest_on_an_interrupted_workspace_sends_nothing()
    {
        await CheckedOutPart();
        File.Move(ManifestPath, SetAsidePath);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => new ArchApiClient(WorkspaceTestSession.Server, new HttpClient(handler)).GetLatestAsync(
            WorkspaceTestSession.Make(), new GetLatestRequest { Root = CadDocumentLookup.ByNumber("PRT-1"), WorkspaceRoot = _root }));

        AssertNoServerRequest(handler);
    }

    // ---- an old manifest left behind is reported by the run that left it --------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_cleanup_the_file_system_refused_is_reported_in_the_same_result()
    {
        await CheckedOutPart();

        var report = await Run(Server(RootPart), "PRT-1", saveManifest: CleanupRefused);

        var artifact = Path.GetFileName(Assert.Single(SetAsideManifests()));
        Assert.Equal(artifact, Path.GetFileName(report.RetainedManifestArtifact));
        Assert.Contains(artifact, report.ToSummaryLine());
        Assert.Contains("manual recovery", report.ToSummaryLine());
        Assert.False(report.ReachedValidState);
        Assert.NotNull(Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cleanup_counts_only_once_the_file_is_confirmed_gone_after_its_handle_closed()
    {
        await CheckedOutPart();

        var report = await Run(Server(RootPart), "PRT-1", saveManifest: manifest => manifest.SaveIfUnchangedSinceLoad(deletePrevious: _ => true));

        Assert.NotNull(report.RetainedManifestArtifact);
        Assert.Single(SetAsideManifests());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_run_after_a_retained_manifest_is_refused_and_keeps_both_files()
    {
        await CheckedOutPart();
        await Run(Server(RootPart), "PRT-1", saveManifest: CleanupRefused);
        var old = Assert.Single(SetAsideManifests());
        var oldBytes = await File.ReadAllBytesAsync(old);
        var saved = await File.ReadAllBytesAsync(ManifestPath);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        AssertNoServerRequest(handler);
        Assert.Equal(oldBytes, await File.ReadAllBytesAsync(old));
        Assert.Equal(saved, await File.ReadAllBytesAsync(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_retained_manifest_survives_cancellation_into_the_exception()
    {
        await TwoStaleCheckouts();
        using var cancel = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (source, target) =>
        {
            File.Move(source, target);
            cancel.Cancel();
        });

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server([AsmNewVersion, DependencyPart], _ => Available), "ASM-1", ct: cancel.Token, materializer: materializer, saveManifest: CleanupRefused));

        Assert.Contains(Path.GetFileName(Assert.Single(SetAsideManifests())), ex.Message);
        Assert.Equal(1, ex.RetainedManifestArtifacts);
        Assert.Equal(1, ex.RetainedRecoveryCopies);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_foreign_file_on_the_empty_path_names_the_verified_manifest_in_the_refusal()
    {
        await CheckedOutPart();

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1", saveManifest: manifest =>
            manifest.SaveIfUnchangedSinceLoad(At(ManifestSaveStep.SetAside, () => File.WriteAllText(ManifestPath, ForeignManifest)))));

        Assert.Contains(Path.GetFileName(Assert.Single(SetAsideManifests())), ex.Message);
        Assert.Equal(1, ex.RetainedManifestArtifacts);
        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_directory_on_the_empty_path_refuses_the_save_and_keeps_the_verified_manifest_aside()
    {
        await CheckedOutPart();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var identity = WorkspaceRecoveryFolder.TryReadFileIdentity(ManifestPath);
        var manifest = WorkspaceManifest.Load(_root).Manifest;

        Assert.Throws<WorkspaceManifestChangedException>(() => manifest.SaveIfUnchangedSinceLoad(
            At(ManifestSaveStep.SetAside, () => Directory.CreateDirectory(ManifestPath))));
        Directory.Delete(ManifestPath);
        var aside = Assert.Single(SetAsideManifests());

        Assert.Equal(identity, WorkspaceRecoveryFolder.TryReadFileIdentity(aside));
        Assert.Equal(before, await File.ReadAllBytesAsync(aside));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_that_could_not_place_the_new_file_rolls_back_through_the_verified_handle()
    {
        await CheckedOutPart();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var identity = WorkspaceRecoveryFolder.TryReadFileIdentity(ManifestPath);
        var manifest = WorkspaceManifest.Load(_root).Manifest;

        var ex = Assert.Throws<WorkspaceManifestPersistException>(() => manifest.SaveIfUnchangedSinceLoad(placeNew: (_, _) => false));

        Assert.Null(ex.RetainedArtifact);
        Assert.Equal(identity, WorkspaceRecoveryFolder.TryReadFileIdentity(ManifestPath));
        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        Assert.Empty(SetAsideManifests());
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(_root).Status);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_rollback_that_also_fails_keeps_the_verified_manifest_aside_and_names_it()
    {
        await CheckedOutPart();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var manifest = WorkspaceManifest.Load(_root).Manifest;
        var arch = new DirectoryInfo(ArchPath);
        var denial = new System.Security.AccessControl.FileSystemAccessRule(
            System.Security.Principal.WindowsIdentity.GetCurrent().User!,
            System.Security.AccessControl.FileSystemRights.CreateFiles,
            System.Security.AccessControl.AccessControlType.Deny);
        var acl = arch.GetAccessControl();
        WorkspaceManifestPersistException? ex;
        try
        {
            ex = Assert.Throws<WorkspaceManifestPersistException>(() => manifest.SaveIfUnchangedSinceLoad(placeNew: (_, _) =>
            {
                acl.AddAccessRule(denial);
                arch.SetAccessControl(acl);
                return false;
            }));
        }
        finally
        {
            acl.RemoveAccessRule(denial);
            arch.SetAccessControl(acl);
        }

        var aside = Assert.Single(SetAsideManifests());
        Assert.Equal(Path.GetFileName(aside), Path.GetFileName(ex.RetainedArtifact));
        Assert.Equal(before, await File.ReadAllBytesAsync(aside));
        Assert.False(File.Exists(ManifestPath));
        Assert.True(WorkspaceRecoveryState.Inspect(_root).IsRecoveryRequired);
    }

    // ---- a stale candidate restored by hand -----------------------------------------

    /// <summary>The state a person creates by restoring a candidate from before the
    ///  checkout: same document, no marker, the server still says it is checked
    ///  out. Nothing can tell this from a clean manifest, which is why the manual
    ///  procedure requires reconciling checkout entries first.</summary>
    private async Task StaleCandidateMissingItsCheckout()
    {
        await Run(Server(RootPart), "PRT-1");
        var withoutMarker = await File.ReadAllBytesAsync(ManifestPath);
        CheckOutLocally(PartPath, RootPart);
        await File.WriteAllBytesAsync(ManifestPath, withoutMarker);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_stale_candidate_missing_a_checkout_never_overwrites_local_edits()
    {
        await StaleCandidateMissingItsCheckout();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);

        var report = await Run(ServerAnswering(RootPartNewVersion, MineJson(RootPart)), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Null(Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_stale_candidate_missing_a_checkout_invents_no_marker()
    {
        await StaleCandidateMissingItsCheckout();

        await Run(Server(RootPart), "PRT-1");

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Null(Entry(PartPath).Checkout);
    }
}
