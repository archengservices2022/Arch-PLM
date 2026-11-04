using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 Milestone 3: end-to-end orchestrator behavior with OldVersions
/// tracking, using a fake file system that models Inventor 2027's MEASURED
/// backup behavior (save moves previous bytes to OldVersions; rotation keeps
/// one per name).
/// </summary>
public class CopyDesignApplyOrchestratorBackupTests
{
    private static (OrchestratorHarness H, FakeBackupFileSystem Fs) Harness()
    {
        var fs = new FakeBackupFileSystem();
        var h = new OrchestratorHarness { BackupFileSystem = fs };
        // The copier "creates" each destination; every adapter save behaves like Inventor's Save2.
        h.Copier.OnCopied = n => fs.Files[n.ProposedDestinationAbsolutePath!] = fs.NewContent("copied:" + n.ProposedDestinationFileName);
        h.MetadataNormalizer.OnSave = n => fs.SimulateInventorSave(n.ProposedDestinationAbsolutePath!);
        h.Rewirer.OnSave = n => fs.SimulateInventorSave(n.ProposedDestinationAbsolutePath!);
        h.DrawingRewirer.OnSave = n => fs.SimulateInventorSave(n.ProposedDestinationAbsolutePath!);
        return (h, fs);
    }

    private static IEnumerable<string> BackupsIn(FakeBackupFileSystem fs, string folder) =>
        fs.Files.Keys.Where(k => k.StartsWith(Path.Combine(folder, "OldVersions"), StringComparison.OrdinalIgnoreCase));

    // ---- IPT / IAM / IDW save paths ------------------------------------------

    [Fact]
    public async Task IPT_the_normalizer_backup_is_owned_and_swept_while_unrelated_backups_stay()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\ARCH-TEST-001.ipt", @"D:\dst\ARCH-TEST-003.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        var unrelated = Path.Combine(@"D:\dst\OldVersions", "ARCH-TEST-001.0001.ipt");
        var similar = Path.Combine(@"D:\dst\OldVersions", "ARCH-TEST-0031.0001.ipt");
        fs.Files[unrelated] = "historical";
        fs.Files[similar] = "historical-similar";

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        var swept = Assert.Single(result.BackupCleanup!.Outcomes);
        Assert.Equal(Path.Combine(@"D:\dst\OldVersions", "ARCH-TEST-003.0002.ipt"), swept.AbsolutePath);
        Assert.True(swept.Deleted);
        Assert.Equal(new[] { similar, unrelated }.OrderBy(x => x), BackupsIn(fs, @"D:\dst").OrderBy(x => x));
        Assert.True(fs.FileExists(node.ProposedDestinationAbsolutePath!)); // the deliverable itself is never touched by the sweep
    }

    [Fact]
    public async Task IAM_two_saves_in_one_attempt_rotation_of_our_own_backup_is_expected_and_the_survivor_is_swept()
    {
        var (h, fs) = Harness();
        var child = CopyNode("cad-c", @"D:\src\C-OLD.ipt", @"D:\dst\C.ipt");
        var root = CopyNode("cad-r", @"D:\src\R-OLD.iam", @"D:\dst\R.iam", CadDocumentType.Iam, isRoot: true);
        h.ExistingSources.Add(child.SourceAbsolutePath);
        h.ExistingSources.Add(root.SourceAbsolutePath);
        var plan = Plan(new[] { root, child }, new[] { ComponentEdge(root, child, childIsCopy: true) });

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        // R.iam: normalizer save -> R.0002.iam (owned), rewirer save -> R.0003.iam (owned), rotation removed R.0002.
        Assert.Contains(result.BackupCleanup!.Outcomes, o => o.AbsolutePath.EndsWith("R.0003.iam", StringComparison.Ordinal) && o.Deleted);
        Assert.DoesNotContain(result.BackupCleanup.Outcomes, o => o.AbsolutePath.EndsWith("R.0002.iam", StringComparison.Ordinal));
        Assert.Contains(result.BackupCleanup.Outcomes, o => o.AbsolutePath.EndsWith("C.0002.ipt", StringComparison.Ordinal) && o.Deleted);
        Assert.Empty(BackupsIn(fs, @"D:\dst"));
    }

    [Fact]
    public async Task IDW_drawing_normalizer_and_drawing_rewirer_backups_are_owned_and_swept()
    {
        var (h, fs) = Harness();
        var model = CopyNode("cad-m", @"D:\src\M-OLD.ipt", @"D:\dst\M.ipt", isRoot: true);
        var drawing = CopyNode("cad-d", @"D:\src\M-OLD.idw", @"D:\dst\M.idw", CadDocumentType.Idw);
        h.ExistingSources.Add(model.SourceAbsolutePath);
        h.ExistingSources.Add(drawing.SourceAbsolutePath);
        var plan = Plan(new[] { model, drawing }, new[] { DrawingModelEdge(drawing, model, modelIsCopy: true) });

        var result = await h.Build().ExecuteAsync(plan, "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Contains(result.BackupCleanup!.Outcomes, o => o.AbsolutePath.EndsWith("M.0003.idw", StringComparison.Ordinal) && o.Deleted);
        Assert.Contains(result.BackupCleanup.Outcomes, o => o.AbsolutePath.EndsWith("M.0002.ipt", StringComparison.Ordinal) && o.Deleted);
        Assert.Empty(BackupsIn(fs, @"D:\dst"));
    }

    [Fact]
    public async Task No_save_and_no_OldVersions_folder_means_no_backup_report_at_all()
    {
        var (h, _) = Harness();
        h.MetadataNormalizer.OnSave = null; // normalizer kept the Part Number - no save
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Null(result.BackupCleanup);
    }

    // ---- historical / ambiguous -------------------------------------------------

    [Fact]
    public async Task A_historical_backup_with_the_destination_name_blocks_before_any_physical_copy_and_is_untouched()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\ARCH-TEST-001.ipt", @"D:\dst\ARCH-TEST-003.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        var historical = Path.Combine(@"D:\dst\OldVersions", "ARCH-TEST-003.0007.ipt");
        fs.Files[historical] = "someone's history";

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.RevalidationFailed, result.Outcome);
        Assert.Contains(historical, result.FailureReason, StringComparison.OrdinalIgnoreCase);
        Assert.Empty(h.Copier.Calls);
        Assert.Equal("someone's history", fs.Files[historical]);
        Assert.Empty(fs.Deleted);
    }

    [Fact]
    public async Task An_unreadable_OldVersions_folder_fails_closed_before_any_physical_copy()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        fs.ThrowOnListFor.Add(node.ProposedDestinationAbsolutePath!);

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.RevalidationFailed, result.Outcome);
        Assert.Contains("fail closed", result.FailureReason, StringComparison.Ordinal);
        Assert.Empty(h.Copier.Calls);
    }

    [Fact]
    public async Task An_unexplained_backup_appearing_during_a_save_fails_closed_and_is_never_deleted()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        var foreign = Path.Combine(@"D:\dst\OldVersions", "B.0009.ipt");
        h.MetadataNormalizer.OnSave = n => fs.Files[foreign] = "not the destination's bytes";

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        Assert.Contains("ownership could not be established", result.FailureReason, StringComparison.Ordinal);
        Assert.True(fs.FileExists(foreign));
        Assert.DoesNotContain(foreign, fs.Deleted);
        Assert.Contains(node.ProposedDestinationAbsolutePath!, h.Deleted); // the attempt's own destination is still cleaned up
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task When_the_pre_save_snapshot_cannot_be_taken_the_save_is_never_attempted()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        h.Copier.OnCopied = null; // destination never appears in the file system -> cannot hash it

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        Assert.Contains("the save was not attempted", result.FailureReason, StringComparison.Ordinal);
        Assert.Empty(h.MetadataNormalizer.Calls);
    }

    // ---- failed / cancelled -------------------------------------------------------

    [Fact]
    public async Task A_failure_after_an_owned_save_removes_the_owned_backup_with_the_destination()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        h.Verifier.FailFor.Add("cad-1");

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.VerificationFailed, result.Outcome);
        var backup = Path.Combine(@"D:\dst\OldVersions", "B.0002.ipt");
        Assert.Contains(result.Cleanup!.Outcomes, o => o.AbsolutePath == backup && o.Deleted);
        Assert.False(fs.FileExists(backup));
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task A_save_cancelled_after_Inventor_wrote_the_backup_still_cleans_up_only_the_owned_backup()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        var historicalOtherName = Path.Combine(@"D:\dst\OldVersions", "Other.0001.ipt");
        fs.Files[historicalOtherName] = "history";
        h.MetadataNormalizer.OnSave = n =>
        {
            fs.SimulateInventorSave(n.ProposedDestinationAbsolutePath!);
            throw new OperationCanceledException("simulated cancellation mid-save");
        };

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.PhysicalCopyFailed, result.Outcome);
        Assert.False(fs.FileExists(Path.Combine(@"D:\dst\OldVersions", "B.0002.ipt")));
        Assert.True(fs.FileExists(historicalOtherName));
    }

    [Fact]
    public async Task A_rewirer_save_that_throws_after_the_backup_still_has_its_backup_cleaned_up()
    {
        var (h, fs) = Harness();
        var child = CopyNode("cad-c", @"D:\src\C-OLD.ipt", @"D:\dst\C.ipt");
        var root = CopyNode("cad-r", @"D:\src\R-OLD.iam", @"D:\dst\R.iam", CadDocumentType.Iam, isRoot: true);
        h.ExistingSources.Add(child.SourceAbsolutePath);
        h.ExistingSources.Add(root.SourceAbsolutePath);
        h.Rewirer.OnSave = n =>
        {
            fs.SimulateInventorSave(n.ProposedDestinationAbsolutePath!);
            throw new InvalidOperationException("simulated COM failure after the backup was written");
        };

        var result = await h.Build().ExecuteAsync(Plan(new[] { root, child }, new[] { ComponentEdge(root, child, childIsCopy: true) }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.ReferenceRewiringFailed, result.Outcome);
        Assert.Empty(BackupsIn(fs, @"D:\dst"));
    }

    // ---- cleanup failure ---------------------------------------------------------------

    [Fact]
    public async Task A_backup_that_cannot_be_deleted_is_reported_and_never_turns_success_into_failure()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        var backup = Path.Combine(@"D:\dst\OldVersions", "B.0002.ipt");
        fs.ThrowOnDeleteFor.Add(backup);

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        var outcome = Assert.Single(result.BackupCleanup!.Outcomes);
        Assert.False(outcome.Deleted);
        Assert.Contains("locked", outcome.FailureReason, StringComparison.Ordinal);
        Assert.True(fs.FileExists(backup));
        Assert.Contains("LEFT IN PLACE - REVIEW", CopyDesignApplyResultTextReport.Render(result), StringComparison.Ordinal);
    }

    // ---- retry / recovery / resume -----------------------------------------------------

    [Fact]
    public async Task Recovery_with_the_same_key_tracks_and_sweeps_backups_exactly_once()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        h.Reservation.ThrowForFirstNCalls = 1;
        var orchestrator = h.Build();

        var first = await orchestrator.ExecuteAsync(Plan(new[] { node }), "original-key", null);
        var recovered = await orchestrator.ExecuteAsync(Plan(new[] { node }), "original-key", null);

        Assert.Equal(CopyDesignApplyOutcome.ReservationCallFailed, first.Outcome);
        Assert.Null(first.BackupCleanup);
        Assert.Equal(CopyDesignApplyOutcome.Succeeded, recovered.Outcome);
        Assert.Single(recovered.BackupCleanup!.Outcomes);
        Assert.Empty(BackupsIn(fs, @"D:\dst"));
    }

    [Fact]
    public async Task A_retry_after_a_failed_cleanup_is_blocked_by_the_leftover_backup_rather_than_risking_it()
    {
        var (h, fs) = Harness();
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);
        h.Verifier.FailFor.Add("cad-1");
        var backup = Path.Combine(@"D:\dst\OldVersions", "B.0002.ipt");
        fs.ThrowOnDeleteFor.Add(backup);
        var orchestrator = h.Build();

        var failed = await orchestrator.ExecuteAsync(Plan(new[] { node }), "key-1", null);
        h.Verifier.FailFor.Clear();
        var retry = await orchestrator.ExecuteAsync(Plan(new[] { node }), "key-2", null);

        Assert.Equal(CopyDesignApplyOutcome.VerificationFailed, failed.Outcome);
        Assert.Contains(failed.Cleanup!.Outcomes, o => o.AbsolutePath == backup && !o.Deleted);
        Assert.Equal(CopyDesignApplyOutcome.RevalidationFailed, retry.Outcome);
        Assert.Contains(backup, retry.FailureReason, StringComparison.OrdinalIgnoreCase);
        Assert.True(fs.FileExists(backup));
    }

    [Fact]
    public async Task Resume_never_checks_or_touches_backups_of_an_entry_already_materialized()
    {
        var (h, fs) = Harness();
        h.IncludeOperationStatusClient = true;
        var done = CopyNode("cad-done", @"D:\src\A.ipt", @"D:\dst\A-new.ipt");
        var pending = CopyNode("cad-pending", @"D:\src\B.ipt", @"D:\dst\B-new.ipt", isRoot: true);
        h.ExistingSources.Add(done.SourceAbsolutePath);
        h.ExistingSources.Add(pending.SourceAbsolutePath);
        var doneDest = done.ProposedDestinationAbsolutePath!;
        var hash = new string('a', 64);
        h.ExistingDestinations.Add(doneDest);
        h.FileSizeFor[doneDest] = 123L;
        h.Hasher.SequencedHashesFor[doneDest] = new Queue<string>(new[] { hash });
        var doneHistory = Path.Combine(@"D:\dst\OldVersions", "A-new.0002.ipt");
        fs.Files[doneHistory] = "backup left by the earlier, materialized attempt";
        h.Reservation.OnResponded = (request, response) =>
        {
            foreach (var entry in response.Entries)
            {
                h.OperationStatusClient.AddPendingIfAbsent(entry.Action == CopyDesignApplyEntryAction.Copy, entry.SourceCadDocumentId,
                    entry.ResultingCadDocumentId, entry.DocumentNumber, entry.FileName, entry.DocumentType);
            }
            h.OperationStatusClient.OperationId = response.CopyDesignOperationId;
            h.OperationStatusClient.IdempotencyKey = request.IdempotencyKey;
            h.OperationStatusClient.MarkMaterialized("cad-done-new", 1, hash, 123L, "fv-resumed-1");
        };

        var result = await h.Build().ExecuteAsync(Plan(new[] { pending, done }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.True(fs.FileExists(doneHistory)); // never checked, never touched
        Assert.DoesNotContain(doneHistory, fs.Deleted);
    }

    [Fact]
    public async Task With_tracking_not_configured_nothing_about_backups_changes()
    {
        var h = new OrchestratorHarness(); // BackupFileSystem = null
        var node = CopyNode("cad-1", @"D:\src\A.ipt", @"D:\dst\B.ipt", isRoot: true);
        h.ExistingSources.Add(node.SourceAbsolutePath);

        var result = await h.Build().ExecuteAsync(Plan(new[] { node }), "key-1", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Null(result.BackupCleanup);
    }
}
