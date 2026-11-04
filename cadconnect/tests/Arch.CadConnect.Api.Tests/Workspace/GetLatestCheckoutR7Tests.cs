using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R7: one lease on <c>.arch</c> from the start of a run
///  through its manifest save, a retained recovery copy reported by the run that
///  kept it, and no record dropped on anything short of proven absence.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private const string ForeignManifest = """
        {"schema":"arch-plm.workspace-manifest.v1","entries":[{"relativePath":"foreign.ipt","cadDocumentId":"cad_foreign",
        "checkout":{"checkoutId":"co_foreign","baseFileVersionId":"fv_foreign","baseVersionNumber":1,"baseChecksum":"","baseFileSize":0}}]}
        """;

    private string ArchPath => Path.Combine(_root, ".arch");

    /// <summary>The orchestrator's third clock read is its manifest update: the
    ///  materializer has returned and nothing has been saved yet.</summary>
    private static Func<DateTimeOffset> OnRecording(Action recording)
    {
        var reads = 0;
        return () =>
        {
            if (++reads == 3)
            {
                recording();
            }
            return DateTimeOffset.UtcNow;
        };
    }

    private void SwapInADifferentRealArchFolder()
    {
        Directory.Move(ArchPath, ArchPath + "-old");
        Directory.CreateDirectory(ArchPath);
        File.WriteAllText(ManifestPath, ForeignManifest);
    }

    private void AssertArchIsReleased()
    {
        Directory.Move(ArchPath, ArchPath + "-released");
        Directory.Move(ArchPath + "-released", ArchPath);
    }

    // ---- one lease, from the first look at .arch through the save -------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_real_arch_folder_cannot_replace_a_new_workspaces_before_the_save()
    {
        Exception? swap = null;

        await Run(Server(RootPart), "PRT-1", clock: OnRecording(() => swap = Record.Exception(SwapInADifferentRealArchFolder)));

        Assert.NotNull(swap);
        Assert.Equal("cad_part", Entry(PartPath).CadDocumentId);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_real_arch_folder_cannot_replace_an_existing_one_before_the_save()
    {
        await CheckedOutPart();
        Exception? swap = null;

        await Run(Server(RootPart), "PRT-1", clock: OnRecording(() => swap = Record.Exception(SwapInADifferentRealArchFolder)));

        Assert.NotNull(swap);
        Assert.NotNull(Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_workspace_folder_cannot_be_moved_away_from_under_the_lease()
    {
        var moved = _root + "-moved";
        Exception? swap = null;
        try
        {
            await Run(Server(RootPart), "PRT-1", clock: OnRecording(() => swap = Record.Exception(() => Directory.Move(_root, moved))));

            Assert.NotNull(swap);
        }
        finally
        {
            if (Directory.Exists(moved))
            {
                Directory.Delete(moved, recursive: true);
            }
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_that_appears_during_a_new_workspaces_run_is_not_adopted()
    {
        var handler = Server([RootPart], onPlan: () => File.WriteAllText(ManifestPath, ForeignManifest));

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.False(File.Exists(PartPath));
        Assert.False(Directory.Exists(Path.Combine(ArchPath, ".staging")));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_new_workspaces_arch_folder_is_already_held_when_the_plan_arrives_and_cannot_be_swapped()
    {
        Exception? swap = null;

        var report = await Run(Server([RootPart], onPlan: () => swap = Record.Exception(SwapInADifferentRealArchFolder)), "PRT-1");

        Assert.NotNull(swap);
        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.False(Directory.Exists(ArchPath + "-old"));
    }

    // ---- an unexpected workspace.json is never overwritten ---------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_that_appears_in_a_new_workspaces_folder_is_not_overwritten()
    {
        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server(RootPart), "PRT-1", clock: OnRecording(() => File.WriteAllText(ManifestPath, ForeignManifest))));

        Assert.Contains("workspace.json", ex.Message);
        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_changed_during_a_run_is_not_overwritten()
    {
        await CheckedOutPart();

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server(RootPart), "PRT-1", clock: OnRecording(() => File.WriteAllText(ManifestPath, ForeignManifest))));

        Assert.Contains("workspace.json", ex.Message);
        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_removed_during_a_run_is_not_written_back_as_if_nothing_happened()
    {
        await CheckedOutPart();

        await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server(RootPart), "PRT-1", clock: OnRecording(() => File.Delete(ManifestPath))));

        Assert.False(File.Exists(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_changed_before_a_cancelled_run_records_its_work_is_not_overwritten()
    {
        await TwoStaleCheckouts();
        using var cancel = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (source, target) =>
        {
            File.Move(source, target);
            cancel.Cancel();
        });

        await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server([AsmNewVersion, DependencyPart], _ => Available), "ASM-1", ct: cancel.Token, materializer: materializer,
                clock: OnRecording(() => File.WriteAllText(ManifestPath, ForeignManifest))));

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
    }

    // ---- the lease ends with the run, however it ends ---------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_lease_is_released_after_a_run_that_created_the_folder()
    {
        await Run(Server(RootPart), "PRT-1");

        AssertArchIsReleased();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_lease_is_released_after_a_run_that_refused_to_save()
    {
        await CheckedOutPart();

        await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server(RootPart), "PRT-1", clock: OnRecording(() => File.WriteAllText(ManifestPath, ForeignManifest))));

        AssertArchIsReleased();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_lease_is_released_after_a_run_that_threw()
    {
        await CheckedOutPart();

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Run(Server([RootPart], onPlan: () => throw new HttpRequestException("gone")), "PRT-1"));

        AssertArchIsReleased();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_lease_is_released_after_a_cancelled_run()
    {
        await CheckedOutPart();
        using var cancel = new CancellationTokenSource();

        await Assert.ThrowsAnyAsync<Exception>(() =>
            Run(Server([RootPart], onPlan: cancel.Cancel), "PRT-1", ct: cancel.Token));

        AssertArchIsReleased();
    }

    // ---- a kept copy is reported by the run that kept it ------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_failed_server_check_reports_the_kept_copy_in_the_same_result()
    {
        await CheckedOutPart();

        var report = await Run(Server([RootPartNewVersion], _ => Available, serveOlderVersions: false), "PRT-1");

        var result = report.Results.Single();
        var copy = Path.GetFileName(Assert.Single(RecoveryFiles()));
        Assert.Equal(MaterializationStatus.Downloaded, result.Status);
        Assert.Contains(copy, result.Reason);
        Assert.Contains("anual recovery", result.Reason);
        Assert.Contains(copy, report.ToSummaryLine());
        Assert.False(report.ReachedValidState);
        Assert.Single(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_during_the_server_check_reports_the_kept_copy_in_the_same_result()
    {
        await CheckedOutPart();
        using var cancel = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (source, target) =>
        {
            File.Move(source, target);
            cancel.Cancel();
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", ct: cancel.Token, materializer: materializer);

        Assert.Contains(Path.GetFileName(Assert.Single(RecoveryFiles())), report.Results.Single().Reason);
        Assert.False(report.ReachedValidState);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_before_more_entries_still_names_the_kept_copy()
    {
        await TwoStaleCheckouts();
        using var cancel = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (source, target) =>
        {
            File.Move(source, target);
            cancel.Cancel();
        });

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server([AsmNewVersion, DependencyPart], _ => Available), "ASM-1", ct: cancel.Token, materializer: materializer));

        Assert.Contains(Path.GetFileName(Assert.Single(RecoveryFiles())), ex.Message);
        Assert.Single(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_failure_does_not_hide_a_kept_copy()
    {
        await CheckedOutPart();
        FileStream? holder = null;
        try
        {
            var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() =>
                Run(Server([RootPartNewVersion], _ => Available, serveOlderVersions: false), "PRT-1",
                    clock: OnRecording(() => holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None))));

            Assert.Contains(Path.GetFileName(Assert.Single(RecoveryFiles())), ex.Message);
        }
        finally
        {
            holder?.Dispose();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_cleanup_refused_by_the_file_system_reports_the_kept_copy_and_does_not_retry()
    {
        await CheckedOutPart();
        var attempts = 0;
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, deleteCopy: _ =>
        {
            attempts++;
            return false;
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        var copy = Assert.Single(RecoveryFiles());
        Assert.Equal(1, attempts);
        Assert.Contains(Path.GetFileName(copy), report.Results.Single().Reason);
        Assert.False(report.ReachedValidState);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
        Assert.Single(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_replacement_that_cleaned_up_reports_no_kept_copy()
    {
        await CheckedOutPart();

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Null(report.Results.Single().Reason);
        Assert.True(report.ReachedValidState);
        Assert.DoesNotContain("recovery", report.ToSummaryLine());
        Assert.Empty(RecoveryFiles());
    }

    // ---- a record goes only on proven absence ----------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Something_other_than_a_file_at_the_copy_path_keeps_the_record()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        File.Delete(copy);
        Directory.CreateDirectory(copy);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.True(File.Exists(JournalOf(captured)));
        Assert.True(Directory.Exists(copy));
    }

    public static TheoryData<Exception> NoAnswers => new()
    {
        new UnauthorizedAccessException("denied"),
        new IOException("busy"),
        new DirectoryNotFoundException("folder gone"),
        new PathTooLongException("too long"),
    };

    [Theory]
    [MemberData(nameof(NoAnswers))]
    [Trait("PackageC", "Policy")]
    public void No_answer_about_a_copy_is_never_taken_for_absence(Exception noAnswer)
    {
        Assert.Equal(RecoveryCopyPresence.Unknown, WorkspaceRecoveryFolder.ProbeCopy("copy.ipt", _ => throw noAnswer));
    }

    [Theory]
    [MemberData(nameof(NoAnswers))]
    [Trait("PackageC", "Policy")]
    public async Task No_answer_about_a_copy_keeps_its_record_even_when_the_copy_is_really_gone(Exception noAnswer)
    {
        var captured = await InterruptedReplacement();
        File.Move(CopyOf(captured), Path.Combine(_root, "kept-elsewhere.ipt"));
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, readCopyAttributes: _ => throw noAnswer);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1", materializer: materializer));

        Assert.Contains("could not determine", ex.Message);
        Assert.True(File.Exists(JournalOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task No_answer_about_a_copy_that_exists_changes_nothing()
    {
        var captured = await InterruptedReplacement();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, readCopyAttributes: _ => throw new UnauthorizedAccessException("denied"));

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1", materializer: materializer));

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
        Assert.True(File.Exists(JournalOf(captured)));
        Assert.False(File.Exists(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public void A_name_nothing_has_is_absent_and_a_folder_is_present()
    {
        Assert.Equal(RecoveryCopyPresence.Absent, WorkspaceRecoveryFolder.ProbeCopy(Path.Combine(_root, "nothing.ipt")));
        Assert.Equal(RecoveryCopyPresence.Present, WorkspaceRecoveryFolder.ProbeCopy(_root));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_proven_absent_clears_its_record()
    {
        var captured = await InterruptedReplacement();
        File.Move(CopyOf(captured), Path.Combine(_root, "kept-elsewhere.ipt"));

        await Run(Server(RootPart), "PRT-1");

        Assert.Empty(RecoveryJournals());
    }
}
