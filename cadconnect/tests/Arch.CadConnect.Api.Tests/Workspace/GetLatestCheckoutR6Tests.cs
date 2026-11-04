using System.Net;
using System.Text.Json.Nodes;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R6: nothing in the workspace can authorize deleting
///  a recovery copy, staging stays inside the workspace, and restoring moves the
///  verified object itself.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private void EditManifestEntry(Action<JsonObject> edit)
    {
        var manifest = JsonNode.Parse(File.ReadAllText(ManifestPath))!;
        edit(manifest["entries"]![0]!.AsObject());
        File.WriteAllText(ManifestPath, manifest.ToJsonString());
    }

    private static void ClaimBaseIs(JsonObject holder, byte[] bytes)
    {
        holder["baseChecksum"] = Sha(bytes);
        holder["baseFileSize"] = bytes.Length;
    }

    // ---- nothing in the workspace authorizes a deletion ------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_forged_record_and_manifest_together_cannot_get_a_unique_copy_deleted()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        await File.WriteAllBytesAsync(copy, EditedBytes);
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);
        EditRecord(JournalOf(captured), record => ClaimBaseIs(record, EditedBytes));
        EditManifestEntry(entry => ClaimBaseIs(entry["checkout"]!.AsObject(), EditedBytes));

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(copy));
        Assert.True(File.Exists(JournalOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_forged_record_with_a_marker_free_manifest_cannot_get_a_unique_copy_deleted()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        await File.WriteAllBytesAsync(copy, EditedBytes);
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);
        EditRecord(JournalOf(captured), record => ClaimBaseIs(record, EditedBytes));
        EditManifestEntry(entry =>
        {
            entry.Remove("checkout");
            entry["checksum"] = Sha(NewPartBytes);
        });

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(copy));
        Assert.True(File.Exists(JournalOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_altered_plan_checksum_cannot_get_a_copy_deleted()
    {
        var captured = await InterruptedReplacement();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        EditRecord(JournalOf(captured), record => record["planChecksum"] = Sha(EditedBytes));
        EditRecord(JournalOf(captured), record => record["planFileSize"] = EditedBytes.Length);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_marker_free_manifest_with_an_empty_path_restores_nothing()
    {
        var captured = await InterruptedReplacement();
        EditManifestEntry(entry =>
        {
            entry.Remove("checkout");
            entry["checksum"] = Sha(NewPartBytes);
        });

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.False(File.Exists(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_corrupted_marker_cannot_get_a_live_replacement_to_delete_unique_bytes()
    {
        await CheckedOutPart();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        EditManifestEntry(entry => ClaimBaseIs(entry["checkout"]!.AsObject(), EditedBytes));

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(Assert.Single(RecoveryFiles())));
        Assert.Single(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_the_server_cannot_confirm_stays_with_its_record_and_the_next_run_names_it()
    {
        await CheckedOutPart();

        await Run(Server([RootPartNewVersion], _ => Available, serveOlderVersions: false), "PRT-1");

        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        var copy = Assert.Single(RecoveryFiles());
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
        Assert.Single(RecoveryJournals());

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));
        Assert.Contains(Path.GetFileName(copy), ex.Message);

        File.Move(copy, Path.Combine(_root, "kept-elsewhere.ipt"));
        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");
        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_goes_only_after_the_server_serves_the_markers_own_version()
    {
        await CheckedOutPart();
        var handler = ServerAnswering(RootPartNewVersion, AvailableJson);

        await Run(handler, "PRT-1");

        Assert.Contains(handler.Requests, r => r.RequestUri!.AbsolutePath == $"/api/file-versions/{RootPart.Fv}/content");
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_during_the_server_check_keeps_the_copy_with_its_record()
    {
        await CheckedOutPart();
        using var cts = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (source, target) =>
        {
            File.Move(source, target);
            cts.Cancel();
        });

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", ct: cts.Token, materializer: materializer);

        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(Assert.Single(RecoveryFiles())));
        Assert.Single(RecoveryJournals());
    }

    // ---- staging stays inside the workspace -------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_junction_at_the_arch_folder_of_a_new_workspace_refuses_with_nothing_written_outside()
    {
        var outside = Outside();
        var arch = Path.Combine(_root, ".arch");
        try
        {
            Junction(arch, outside);
            var handler = Server(RootPart);

            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

            Assert.Empty(Directory.GetFileSystemEntries(outside));
            Assert.Empty(handler.Requests);
            Assert.False(File.Exists(PartPath));
        }
        finally
        {
            Directory.Delete(arch);
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_junction_at_the_arch_folder_holding_a_manifest_refuses_and_changes_nothing_outside()
    {
        await Run(Server(RootPart), "PRT-1");
        var outside = Outside();
        var arch = Path.Combine(_root, ".arch");
        var moved = Path.Combine(outside, "held");
        Directory.Move(arch, moved);
        var manifest = await File.ReadAllBytesAsync(Path.Combine(moved, "workspace.json"));
        try
        {
            Junction(arch, moved);
            File.SetAttributes(PartPath, FileAttributes.Normal);
            File.Delete(PartPath);

            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

            Assert.Equal(manifest, await File.ReadAllBytesAsync(Path.Combine(moved, "workspace.json")));
            Assert.False(Directory.Exists(Path.Combine(moved, ".staging")) && Directory.GetFiles(Path.Combine(moved, ".staging")).Length > 0);
            Assert.False(File.Exists(PartPath));
        }
        finally
        {
            Directory.Delete(arch);
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_junction_at_the_staging_folder_blocks_the_download_with_nothing_written_outside()
    {
        await Run(Server(RootPart), "PRT-1");
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);
        var outside = Outside();
        var staging = Path.Combine(_root, ".arch", ".staging");
        var entry = JsonOf(Entry(PartPath));
        if (Directory.Exists(staging))
        {
            Directory.Delete(staging);
        }
        try
        {
            Junction(staging, outside);
            var handler = Server(RootPart);

            var report = await Run(handler, "PRT-1");

            var result = report.Results.Single();
            Assert.Equal(MaterializationStatus.Blocked, result.Status);
            Assert.Contains("staging", result.Reason);
            Assert.Empty(Directory.GetFileSystemEntries(outside));
            Assert.False(File.Exists(PartPath));
            Assert.Equal(entry, JsonOf(Entry(PartPath)));
            Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(staging);
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_at_the_staging_folder_path_blocks_the_download()
    {
        await Run(Server(RootPart), "PRT-1");
        File.SetAttributes(PartPath, FileAttributes.Normal);
        File.Delete(PartPath);
        var staging = Path.Combine(_root, ".arch", ".staging");
        if (Directory.Exists(staging))
        {
            Directory.Delete(staging);
        }
        await File.WriteAllTextAsync(staging, "not a folder");

        var report = await Run(Server(RootPart), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Equal("not a folder", await File.ReadAllTextAsync(staging));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_staging_folder_cannot_be_swapped_while_a_run_is_downloading()
    {
        var staging = Path.Combine(_root, ".arch", ".staging");
        Exception? swap = null;

        await Run(Server([RootPart], content: d =>
        {
            swap = Record.Exception(() => Directory.Move(staging, staging + "-moved"));
            return Content(d);
        }), "PRT-1");

        Assert.NotNull(swap);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
    }

    // ---- every handle is released ---------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public void A_pinned_folder_releases_every_handle_when_creating_a_subfolder_fails()
    {
        var arch = Path.Combine(_root, ".arch");
        Directory.CreateDirectory(arch);

        var folder = WorkspaceRecoveryFolder.TryOpen(_root, create: true, createDirectory: _ => throw new IOException("disk full"));

        Assert.Null(folder);
        Directory.Move(arch, arch + "-moved");
        Directory.Move(arch + "-moved", arch);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public void A_pinned_folder_releases_its_handles_when_a_subfolder_is_refused()
    {
        var arch = Path.Combine(_root, ".arch");
        Directory.CreateDirectory(arch);
        File.WriteAllText(Path.Combine(arch, ".recovery"), "not a folder");

        Assert.Null(WorkspaceRecoveryFolder.TryOpen(_root, create: true));

        Directory.Move(arch, arch + "-moved");
        Directory.Move(arch + "-moved", arch);
    }

    // ---- restoring moves the verified object ---------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_pinned_file_moves_as_the_same_object_and_keeps_its_bytes_and_attribute()
    {
        var source = Path.Combine(_root, "source.ipt");
        var target = Path.Combine(_root, "target.ipt");
        await File.WriteAllBytesAsync(source, PartBytes);
        File.SetAttributes(source, FileAttributes.ReadOnly);
        var identity = WorkspaceRecoveryFolder.TryReadFileIdentity(source);

        using (var pinned = PinnedRecoveryCopy.TryOpen(source))
        {
            Assert.True(pinned!.TryRenameTo(target));
        }

        Assert.False(File.Exists(source));
        Assert.Equal(identity, WorkspaceRecoveryFolder.TryReadFileIdentity(target));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(target));
        Assert.True(ManagedFileGuard.IsControlled(target));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_pinned_file_never_replaces_a_file_at_its_destination()
    {
        var source = Path.Combine(_root, "source.ipt");
        var target = Path.Combine(_root, "target.ipt");
        await File.WriteAllBytesAsync(source, PartBytes);
        await File.WriteAllBytesAsync(target, EditedBytes);

        using (var pinned = PinnedRecoveryCopy.TryOpen(source))
        {
            Assert.False(pinned!.TryRenameTo(target));
        }

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(source));
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(target));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_cannot_be_swapped_while_a_restart_is_restoring_it()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        var marker = Entry(PartPath).Checkout;
        Exception? swap = null;
        var probe = new ScriptedProbe(_ =>
        {
            swap ??= Record.Exception(() =>
            {
                File.Move(copy, copy + ".swapped");
                File.WriteAllBytes(copy, EditedBytes);
            });
            return false;
        });

        await Run(Server([RootPartNewVersion], StatusFails), "PRT-1", materializer: With(probe));

        Assert.NotNull(swap);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(marker, Entry(PartPath).Checkout);
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_that_appears_while_a_restart_restores_stays_and_so_does_the_copy()
    {
        var captured = await InterruptedReplacement();
        var probe = new ScriptedProbe(_ =>
        {
            File.WriteAllBytes(PartPath, EditedBytes);
            return false;
        });

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1", materializer: With(probe)));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
        Assert.True(File.Exists(JournalOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_target_swapped_just_before_it_moves_aside_is_never_treated_as_the_original()
    {
        await CheckedOutPart();
        var entry = JsonOf(Entry(PartPath));
        var probe = new ScriptedProbe(call =>
        {
            if (call == 2)
            {
                File.Delete(PartPath);
                File.WriteAllBytes(PartPath, EditedBytes);
            }
            return false;
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.StaleConflictReason, report.Results.Single().Reason);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task During_a_failed_promotion_the_original_goes_back_as_the_same_object()
    {
        await CheckedOutPart();
        var before = WorkspaceRecoveryFolder.TryReadFileIdentity(PartPath);
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (_, _) => throw new IOException("no"));

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        Assert.Equal(before, WorkspaceRecoveryFolder.TryReadFileIdentity(PartPath));
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }
}
