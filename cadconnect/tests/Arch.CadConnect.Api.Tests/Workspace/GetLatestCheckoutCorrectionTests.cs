using System.Net;
using System.Text.Json;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C corrections: stale-base replacement, path
///  conflicts, unbound existing files, and the failure paths around them.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private static readonly Doc RootPartOlderPlan = RootPart with { Fv = "fv_part_old", Version = 1, Bytes = NewPartBytes };
    private static readonly Doc OtherAtPartPath = RootPart with { Id = "cad_other", Number = "OTH-1", Fv = "fv_other", Bytes = NewPartBytes };

    private string StagingPath => Path.Combine(_root, ".arch", ".staging");

    private string ManifestRoot()
    {
        using var json = JsonDocument.Parse(File.ReadAllText(ManifestPath));
        return json.RootElement.GetProperty("rootCadDocumentId").GetString()!;
    }

    private void AssertNoStagedFiles() =>
        Assert.Empty(Directory.Exists(StagingPath) ? Directory.GetFiles(StagingPath) : []);

    // ---- stale checkout, exact base bytes, newer plan: safe replacement ---

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(StaleAnswers))]
    public async Task The_unchanged_base_of_a_stale_checkout_is_replaced_by_a_newer_plan_version(string staleAnswer)
    {
        await CheckedOutPart();

        var report = await Run(ServerAnswering(RootPartNewVersion, staleAnswer), "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        var entry = Entry(PartPath);
        Assert.Null(entry.Checkout);
        Assert.Equal("fv_part_new", entry.FileVersionId);
        Assert.Equal(WorkspaceManifestEntryState.Verified, entry.State);
        Assert.Equal(LocalCheckoutState.Controlled, CheckoutStateMachine.Evaluate(entry, fileExists: true));
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_read_only_unchanged_base_is_replaced_too()
    {
        await CheckedOutPart();
        File.SetAttributes(PartPath, FileAttributes.ReadOnly);

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_plan_that_is_not_newer_than_the_base_blocks_and_changes_nothing()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPartOlderPlan, AvailableJson);

        var report = await Run(handler, "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.StaleConflictReason, report.Results.Single().Reason);
        await unchanged();
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Bytes_that_change_during_the_download_are_not_replaced()
    {
        await CheckedOutPart();
        var entry = JsonSerializer.Serialize(Entry(PartPath));

        var report = await Run(Server([RootPartNewVersion], _ => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson), content: d =>
        {
            File.WriteAllBytes(PartPath, EditedBytes);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(d.Bytes) };
        }), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.StaleConflictReason, report.Results.Single().Reason);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(entry, JsonSerializer.Serialize(Entry(PartPath)));
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_failed_download_keeps_the_stale_base_and_its_record()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server([RootPartNewVersion], _ => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson),
            content: _ => FakeHttpHandler.Json(HttpStatusCode.InternalServerError, "{}")), "PRT-1");

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_replacement_that_fails_verification_keeps_the_stale_base_and_its_record()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server([RootPartNewVersion], _ => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson),
            content: _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(new byte[NewPartBytes.Length]) }), "PRT-1");

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_during_the_replacement_download_keeps_the_stale_base_and_its_record()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        using var cancel = new CancellationTokenSource();
        var handler = Server([RootPartNewVersion], _ => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson), content: d =>
        {
            cancel.Cancel();
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(d.Bytes) };
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(handler, "PRT-1", ct: cancel.Token));

        await unchanged();
        AssertNoStagedFiles();
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_failed_replacement_keeps_the_original_file_attribute_and_record(bool readOnly)
    {
        await CheckedOutPart();
        if (readOnly)
        {
            File.SetAttributes(PartPath, FileAttributes.ReadOnly);
        }
        var unchanged = await ExpectUnchanged(PartPath);
        var failing = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (_, _) => throw new IOException("sharing violation"));

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: failing);

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Failed, result.Status);
        Assert.Contains("Could not replace the local file", result.Reason);
        await unchanged();
        AssertNoStagedFiles();
    }

    // ---- a different document at the same path -----------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_document_over_a_checked_out_path_blocks_and_leaves_the_manifest_unchanged()
    {
        await CheckedOutPart();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = Server(OtherAtPartPath);

        var report = await Run(handler, "OTH-1");

        Assert.Equal(GetLatestCheckoutPolicy.PathConflictCheckedOutReason, report.Results.Single().Reason);
        await unchanged();
        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        AssertOnlyReads(handler, expectedCount: 2, expectedStatusReads: 0);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_document_over_a_checked_out_path_with_the_file_missing_still_blocks()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server(OtherAtPartPath), "OTH-1");

        Assert.Equal(GetLatestCheckoutPolicy.PathConflictCheckedOutReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_document_over_an_existing_unmarked_file_blocks_with_guidance()
    {
        await Run(Server(RootPart), "PRT-1");
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = Server(OtherAtPartPath);

        var report = await Run(handler, "OTH-1");

        var result = report.Results.Single();
        Assert.Equal(GetLatestCheckoutPolicy.PathConflictReason, result.Reason);
        Assert.Contains("Use another workspace folder", result.Reason);
        await unchanged();
        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        AssertOnlyReads(handler, expectedCount: 2, expectedStatusReads: 0);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_document_adopts_an_unmarked_path_whose_file_is_missing()
    {
        await Run(Server(RootPart), "PRT-1");
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);

        var report = await Run(Server(OtherAtPartPath), "OTH-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal("cad_other", Entry(PartPath).CadDocumentId);
        Assert.Single(WorkspaceManifest.LoadOrEmpty(_root).Entries);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_failed_adoption_keeps_the_previous_entry()
    {
        await Run(Server(RootPart), "PRT-1");
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server([OtherAtPartPath], content: _ => FakeHttpHandler.Json(HttpStatusCode.InternalServerError, "{}")), "OTH-1");

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_that_appears_during_adoption_is_not_overwritten()
    {
        await Run(Server(RootPart), "PRT-1");
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);
        var unchanged = JsonSerializer.Serialize(Entry(PartPath));

        var report = await Run(Server([OtherAtPartPath], content: d =>
        {
            File.WriteAllBytes(PartPath, EditedBytes);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(d.Bytes) };
        }), "OTH-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(unchanged, JsonSerializer.Serialize(Entry(PartPath)));
    }

    // ---- existing files no manifest entry describes ------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_empty_workspace_downloads_normally_with_no_status_read()
    {
        var handler = Server(RootPart);

        var report = await Run(handler, "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(WorkspaceManifestEntryState.Verified, Entry(PartPath).State);
        AssertOnlyReads(handler, expectedCount: 3, expectedStatusReads: 0);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_missing_manifest_over_a_file_checked_out_to_this_user_blocks_and_invents_no_marker()
    {
        await File.WriteAllBytesAsync(PartPath, PartBytes);

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart)), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.CheckoutWithoutRecordReason, report.Results.Single().Reason);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.False(File.Exists(ManifestPath), "no manifest was invented for a blocked run");
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(StaleAnswers))]
    public async Task A_missing_manifest_over_a_file_proven_not_checked_out_to_this_user_is_adopted_read_only(string answer)
    {
        await File.WriteAllBytesAsync(PartPath, PartBytes);

        var report = await Run(ServerAnswering(RootPart, answer), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Null(Entry(PartPath).Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Verified, Entry(PartPath).State);
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_missing_manifest_with_an_unknown_status_blocks_and_changes_nothing(bool readOnly)
    {
        await File.WriteAllBytesAsync(PartPath, PartBytes);
        if (readOnly)
        {
            File.SetAttributes(PartPath, FileAttributes.ReadOnly);
        }

        var report = await Run(ServerAnswering(RootPart, "{}", HttpStatusCode.InternalServerError), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, report.Results.Single().Reason);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(readOnly, ManagedFileGuard.IsControlled(PartPath));
        Assert.False(File.Exists(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_missing_manifest_with_no_status_client_blocks()
    {
        await File.WriteAllBytesAsync(PartPath, PartBytes);

        var report = await Run(Server(RootPart), "PRT-1", withStatusClient: false);

        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, report.Results.Single().Reason);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_missing_manifest_never_overwrites_a_different_file()
    {
        await File.WriteAllBytesAsync(PartPath, EditedBytes);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_without_an_entry_for_an_existing_file_gets_the_same_protection()
    {
        await Run(Server(Other), "OTH-1");
        await File.WriteAllBytesAsync(PartPath, PartBytes);

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart)), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.CheckoutWithoutRecordReason, report.Results.Single().Reason);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Null(WorkspaceManifest.LoadOrEmpty(_root).FindByAbsolutePath(PartPath));
    }

    // ---- block decisions come first ----------------------------------------

    private static WorkspacePlanEntry PlanEntry(string id, string relativePath) => new()
    {
        CadDocumentId = id,
        DocumentNumber = id,
        FileName = "part.ipt",
        CadType = "IPT",
        Placement = new WorkspacePlanPlacement { GeneratedRelativePath = relativePath },
        CanMaterialize = true,
        Version = new WorkspacePlanVersion
        {
            FileVersionId = "fv_" + id,
            VersionNumber = 1,
            Checksum = Sha(PartBytes),
            FileSize = PartBytes.Length,
            OriginalFileName = "part.ipt",
            ContentPath = $"/api/file-versions/fv_{id}/content",
        },
    };

    private static WorkspacePlan PlanOf(params WorkspacePlanEntry[] entries) => new()
    {
        Contract = new WorkspacePlanContractRef { Id = WorkspacePlanContract.Id, Version = WorkspacePlanContract.Version },
        Root = new WorkspacePlanRoot { CadDocumentId = entries[0].CadDocumentId },
        Safe = true,
        Entries = entries,
    };

    public static TheoryData<string> PathsOtherChecksRefuse => new() { @"..\outside.ipt", "part.ipt" };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(PathsOtherChecksRefuse))]
    public async Task A_block_decision_wins_over_path_and_collision_checks(string relativePath)
    {
        var plan = PlanOf(PlanEntry("cad_a", relativePath), PlanEntry("cad_b", "part.ipt"));
        var decisions = new Dictionary<string, GetLatestEntryDecision>
        {
            ["cad_a"] = GetLatestEntryDecision.Block(GetLatestCheckoutPolicy.StatusUnknownReason),
        };

        var report = await new WorkspaceMaterializer().MaterializeAsync(plan, _root, new FakeContentDownloader(), decisions: decisions);

        var result = report.Results.Single(r => r.CadDocumentId == "cad_a");
        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, result.Reason);
        Assert.Equal(MaterializationManifestAction.PreserveEntry, result.ManifestAction);
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(PathsOtherChecksRefuse))]
    public async Task A_kept_checkout_refused_by_a_path_check_keeps_its_record(string relativePath)
    {
        var plan = PlanOf(PlanEntry("cad_a", relativePath), PlanEntry("cad_b", "part.ipt"));
        var decisions = new Dictionary<string, GetLatestEntryDecision> { ["cad_a"] = GetLatestEntryDecision.KeepCheckout };

        var report = await new WorkspaceMaterializer().MaterializeAsync(plan, _root, new FakeContentDownloader(), decisions: decisions);

        var result = report.Results.Single(r => r.CadDocumentId == "cad_a");
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Equal(MaterializationManifestAction.PreserveEntry, result.ManifestAction);
    }

    // ---- writability of a proven checkout ----------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_proven_checkout_that_lost_its_writability_gets_it_back()
    {
        await CheckedOutPart();
        File.SetAttributes(PartPath, FileAttributes.ReadOnly);

        await Run(Server(RootPart), "PRT-1");

        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_current_checked_out_file_that_cannot_be_made_writable_is_reported_and_keeps_its_record()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server(RootPart), "PRT-1", materializer: new WorkspaceMaterializer(setWritable: _ => false));

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Failed, result.Status);
        Assert.Equal(GetLatestCheckoutPolicy.NotWritableReason, result.Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_restored_checked_out_file_that_cannot_be_made_writable_is_reported_and_keeps_its_record()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var entry = JsonSerializer.Serialize(Entry(PartPath));

        var report = await Run(Server(RootPart), "PRT-1", materializer: new WorkspaceMaterializer(setWritable: _ => false));

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Failed, result.Status);
        Assert.Equal(GetLatestCheckoutPolicy.NotWritableReason, result.Reason);
        Assert.Equal(entry, JsonSerializer.Serialize(Entry(PartPath)));
    }

    // ---- failure paths -----------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_marked_file_that_cannot_be_hashed_keeps_its_record()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        MaterializationReport report;
        using (new FileStream(PartPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            report = await Run(Server(RootPart), "PRT-1");
        }

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_stale_marker_keeps_its_record_when_the_missing_file_cannot_be_downloaded()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server([RootPart], _ => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson),
            content: _ => FakeHttpHandler.Json(HttpStatusCode.InternalServerError, "{}")), "PRT-1");

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_failure_after_a_restored_checkout_is_reported()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        FileStream? holder = null;
        var handler = Server([RootPart], content: d =>
        {
            holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None);
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(d.Bytes) };
        });

        try
        {
            var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));
            Assert.Contains("could not be saved", ex.Message);
        }
        finally
        {
            holder?.Dispose();
        }
        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_failure_after_clearing_a_stale_marker_is_reported()
    {
        await CheckedOutPart();
        FileStream? holder = null;
        var handler = Server([RootPart], _ => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson));

        try
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1",
                clock: OnRecording(() => holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None))));
        }
        finally
        {
            holder?.Dispose();
        }
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_save_failure_when_nothing_changed_stays_quiet()
    {
        await Run(Server(RootPart), "PRT-1");
        FileStream? holder = null;
        var handler = Server(RootPart);

        try
        {
            var report = await Run(handler, "PRT-1",
                clock: OnRecording(() => holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None)));
            Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        }
        finally
        {
            holder?.Dispose();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_during_a_status_read_for_an_unbound_file_changes_nothing()
    {
        await File.WriteAllBytesAsync(PartPath, PartBytes);
        using var cancel = new CancellationTokenSource();
        var handler = Server([RootPart], _ =>
        {
            cancel.Cancel();
            return FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(handler, "PRT-1", ct: cancel.Token));

        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.False(File.Exists(ManifestPath));
    }

    // ---- several entries, root metadata ------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Several_markers_are_each_decided_on_their_own_answer()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        var asmPath = Path.Combine(_root, "asm.iam");
        CheckOutLocally(PartPath, DependencyPart);
        CheckOutLocally(asmPath, Asm);
        var handler = Server([Asm, DependencyPart], path => path.Contains("cad_part", StringComparison.Ordinal)
            ? FakeHttpHandler.Json(HttpStatusCode.OK, MineJson(DependencyPart))
            : FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson));

        await Run(handler, "ASM-1");

        Assert.Equal(Binding(DependencyPart), Entry(PartPath).Checkout);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Null(Entry(asmPath).Checkout);
        Assert.True(ManagedFileGuard.IsControlled(asmPath));
        AssertOnlyReads(handler, expectedCount: 4, expectedStatusReads: 2);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_marked_entry_that_cannot_be_materialized_gets_no_status_read_and_stays_as_it_was()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = Server(RootPart with { CanMaterialize = false });

        await Run(handler, "PRT-1");

        await unchanged();
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.EndsWith("/checkout", StringComparison.Ordinal));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_marked_document_whose_plan_path_changed_keeps_its_old_entry()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server(RootPart with { FileName = "renamed.ipt" }), "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_blocked_root_does_not_become_the_manifest_root()
    {
        await Run(Server(Other), "OTH-1");
        var second = new Doc("cad_root2", "ROOT-2", "other.ipt", "IPT", "fv_root2", 1, PartBytes, true, "cad_part");

        var report = await Run(Server(second, DependencyPart), "ROOT-2");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single(r => r.CadDocumentId == "cad_root2").Status);
        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single(r => r.CadDocumentId == "cad_part").Status);
        Assert.Equal("cad_other", ManifestRoot());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_current_root_becomes_the_manifest_root()
    {
        await Run(Server(Other), "OTH-1");

        await Run(Server(RootPart), "PRT-1");

        Assert.Equal("cad_part", ManifestRoot());
    }

    // ---- production wiring -------------------------------------------------

    private Task<MaterializationReport> RunThroughApiClient(FakeHttpHandler handler) =>
        new ArchApiClient(WorkspaceTestSession.Server, new HttpClient(handler)).GetLatestAsync(
            WorkspaceTestSession.Make(),
            new GetLatestRequest { Root = CadDocumentLookup.ByNumber("PRT-1"), WorkspaceRoot = _root });

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_production_client_reads_status_and_keeps_a_valid_checkout()
    {
        await CheckedOutPart();
        var handler = Server(RootPart);

        var report = await RunThroughApiClient(handler);

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        AssertOnlyReads(handler, expectedCount: 3, expectedStatusReads: 1);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_production_client_uses_the_strict_status_read()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await RunThroughApiClient(ServerAnswering(RootPart, """{"state":"something-new"}"""));

        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, report.Results.Single().Reason);
        await unchanged();
    }
}
