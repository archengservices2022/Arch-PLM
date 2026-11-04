using System.Text.Json.Nodes;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>Skips, visibly, on a machine that cannot create symbolic links, so
///  a run that never exercised one cannot report a pass. Junctions, which need no
///  privilege, have their own tests.</summary>
public sealed class SymbolicLinkFactAttribute : FactAttribute
{
    private static readonly Lazy<bool> CanCreate = new(() =>
    {
        var folder = Path.Combine(Path.GetTempPath(), "arch-cc-pkgc-link-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            Directory.CreateSymbolicLink(Path.Combine(folder, "link"), folder);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    });

    public SymbolicLinkFactAttribute()
    {
        if (!CanCreate.Value)
        {
            Skip = "This machine cannot create symbolic links (needs Developer Mode or elevation), so this assertion did not run.";
        }
    }
}

/// <summary>P6 M4.4 Package C R5: what a recovery record may authorize, the
///  recovery copy from its hash to its deletion, and containment before anything
///  is created.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private static string JournalOf(Dictionary<string, byte[]> captured) =>
        captured.Keys.Single(f => f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));

    private static string CopyOf(Dictionary<string, byte[]> captured) =>
        captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));

    private static void EditRecord(string journal, Action<JsonObject> edit)
    {
        var record = JsonNode.Parse(File.ReadAllText(journal))!.AsObject();
        edit(record);
        File.WriteAllText(journal, record.ToJsonString());
    }

    // ---- what a record may authorize -----------------------------------------

    public static TheoryData<string> MandatoryFields => new()
    {
        "schema", "operationId", "relativePath", "cadDocumentId", "checkoutId", "asideFileName",
        "baseChecksum", "baseFileSize", "planChecksum", "planFileSize", "fileVolumeSerial", "fileIndex",
    };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(MandatoryFields))]
    public async Task A_record_missing_a_field_authorizes_nothing(string field)
    {
        var captured = await InterruptedReplacement();
        var journal = JournalOf(captured);
        var copy = CopyOf(captured);
        Assert.Contains(field, await File.ReadAllTextAsync(journal));
        EditRecord(journal, record => record.Remove(field));
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Empty(handler.Requests);
        Assert.False(File.Exists(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
        Assert.True(File.Exists(journal));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_record_whose_file_name_does_not_match_its_copy_authorizes_nothing()
    {
        var captured = await InterruptedReplacement();
        var journal = JournalOf(captured);
        var renamed = Path.Combine(RecoveryPath, "something-else.pending.json");
        File.Move(journal, renamed);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.True(File.Exists(renamed));
        Assert.False(File.Exists(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
    }

    public static TheoryData<string, string> WrongIdentities => new()
    {
        { "cadDocumentId", "cad_other" },
        { "checkoutId", "co_other" },
        { "baseChecksum", new string('0', 64) },
        { "operationId", new string('0', 32) },
        { "relativePath", "other.ipt" },
    };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(WrongIdentities))]
    public async Task A_record_that_disagrees_with_the_manifest_or_its_copy_authorizes_nothing(string field, string value)
    {
        var captured = await InterruptedReplacement();
        EditRecord(JournalOf(captured), record => record[field] = value);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Empty(handler.Requests);
        Assert.False(File.Exists(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manipulated_checksum_cannot_get_a_changed_copy_deleted()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);
        await File.WriteAllBytesAsync(copy, EditedBytes);
        EditRecord(JournalOf(captured), record =>
        {
            record["baseChecksum"] = Sha(EditedBytes);
            record["baseFileSize"] = EditedBytes.Length;
        });

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(copy));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_record_pointing_at_an_unrelated_recovery_file_cannot_move_or_delete_it()
    {
        var captured = await InterruptedReplacement();
        var unrelated = Path.Combine(RecoveryPath, "part.recovery-from-undo.ipt");
        await File.WriteAllBytesAsync(unrelated, EditedBytes);
        EditRecord(JournalOf(captured), record => record["asideFileName"] = Path.GetFileName(unrelated));

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(unrelated));
        Assert.False(File.Exists(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_recovery_copy_that_is_a_different_file_with_the_same_name_is_not_touched()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        File.Delete(copy);
        await File.WriteAllBytesAsync(copy, PartBytes);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
        Assert.False(File.Exists(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cleanup_never_deletes_a_copy_replaced_by_a_different_file_with_the_base_bytes()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);
        File.Delete(copy);
        await File.WriteAllBytesAsync(copy, PartBytes);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        Assert.True(File.Exists(copy), "only the verified object may be deleted");
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_record_with_no_manifest_entry_to_vouch_for_it_authorizes_nothing()
    {
        var captured = await InterruptedReplacement();
        File.Delete(ManifestPath);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.False(File.Exists(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(CopyOf(captured)));
    }

    // ---- the copy from its hash to its deletion -------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task During_promotion_the_verified_copy_cannot_be_changed_or_replaced()
    {
        await CheckedOutPart();
        Exception? write = null;
        Exception? replace = null;
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (source, target) =>
        {
            var copy = RecoveryFiles().Single();
            write = Record.Exception(() => File.WriteAllBytes(copy, EditedBytes));
            replace = Record.Exception(() => File.Move(copy, copy + ".swapped"));
            File.Move(source, target);
        });

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        Assert.NotNull(write);
        Assert.NotNull(replace);
        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_read_only_verified_copy_is_still_removed_after_promotion()
    {
        await CheckedOutPart();
        File.SetAttributes(PartPath, FileAttributes.ReadOnly);

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_target_with_more_than_one_hard_link_is_not_moved()
    {
        await CheckedOutPart();
        var other = Path.Combine(_root, "alias.ipt");
        Assert.True(CreateHardLink(other, PartPath, IntPtr.Zero));
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        await unchanged();
        Assert.Empty(RecoveryFiles());
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string fileName, string existingFileName, IntPtr securityAttributes);

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_pinned_copy_cannot_be_written_renamed_or_deleted_by_path_while_held()
    {
        var path = Path.Combine(_root, "copy.ipt");
        await File.WriteAllBytesAsync(path, PartBytes);

        using var copy = PinnedRecoveryCopy.TryOpen(path);

        Assert.NotNull(copy);
        Assert.NotNull(Record.Exception(() => File.WriteAllBytes(path, EditedBytes)));
        Assert.NotNull(Record.Exception(() => File.Move(path, path + ".moved")));
        Assert.NotNull(Record.Exception(() => File.Delete(path)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_pinned_copy_goes_only_when_told_and_only_through_its_own_handle()
    {
        var path = Path.Combine(_root, "copy.ipt");
        await File.WriteAllBytesAsync(path, PartBytes);

        using (PinnedRecoveryCopy.TryOpen(path)) { }
        Assert.True(File.Exists(path), "closing without deleting keeps the file");

        File.SetAttributes(path, FileAttributes.ReadOnly);
        using (var copy = PinnedRecoveryCopy.TryOpen(path))
        {
            Assert.True(copy!.TryDelete());
        }
        Assert.False(File.Exists(path));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_that_is_a_hard_link_or_cannot_be_held_is_not_pinned()
    {
        var path = Path.Combine(_root, "copy.ipt");
        await File.WriteAllBytesAsync(path, PartBytes);
        using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            Assert.Null(PinnedRecoveryCopy.TryOpen(path));
        }

        Assert.True(CreateHardLink(path + ".alias", path, IntPtr.Zero));
        Assert.Null(PinnedRecoveryCopy.TryOpen(path));
        Assert.Null(WorkspaceRecoveryFolder.TryReadFileIdentity(path));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_restart_cleanup_keeps_a_copy_another_process_has_open()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);

        using (new FileStream(copy, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));
        }

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
        Assert.True(File.Exists(JournalOf(captured)));
    }

    // ---- containment before creation ------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public void A_junction_at_the_arch_folder_gets_nothing_created_behind_it()
    {
        var workspace = Path.Combine(_root, "ws");
        Directory.CreateDirectory(workspace);
        var outside = Outside();
        try
        {
            Junction(Path.Combine(workspace, ".arch"), outside);

            Assert.Null(WorkspaceRecoveryFolder.TryOpen(workspace, create: true));

            Assert.Empty(Directory.GetFileSystemEntries(outside));
        }
        finally
        {
            Directory.Delete(Path.Combine(workspace, ".arch"));
            RemoveJunctionAndOutside();
        }
    }

    [SymbolicLinkFact]
    [Trait("PackageC", "Policy")]
    public void A_symbolic_link_at_the_arch_folder_gets_nothing_created_behind_it()
    {
        var workspace = Path.Combine(_root, "ws");
        Directory.CreateDirectory(workspace);
        var outside = Outside();
        var arch = Path.Combine(workspace, ".arch");
        try
        {
            Directory.CreateSymbolicLink(arch, outside);

            Assert.Null(WorkspaceRecoveryFolder.TryOpen(workspace, create: true));

            Assert.Empty(Directory.GetFileSystemEntries(outside));
        }
        finally
        {
            Directory.Delete(arch);
            RemoveJunctionAndOutside();
        }
    }

    [SymbolicLinkFact]
    [Trait("PackageC", "Policy")]
    public async Task A_symbolic_link_at_the_recovery_folder_refuses_and_nothing_leaves_the_workspace()
    {
        await CheckedOutPart();
        var outside = Outside();
        try
        {
            Directory.CreateSymbolicLink(RecoveryPath, outside);
            var unchanged = await ExpectUnchanged(PartPath);

            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

            await unchanged();
            Assert.Empty(Directory.GetFileSystemEntries(outside));
        }
        finally
        {
            Directory.Delete(RecoveryPath);
            RemoveJunctionAndOutside();
        }
    }

    // ---- recovery guidance ------------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_interrupted_update_names_both_the_copy_and_the_record_and_says_to_move_only_the_copy()
    {
        var captured = await InterruptedReplacement();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.Contains(Path.GetFileName(CopyOf(captured)), ex.Message);
        Assert.Contains(Path.GetFileName(JournalOf(captured)), ex.Message);
        Assert.Contains("CAD recovery copy", ex.Message);
        Assert.Contains("recovery record", ex.Message);
        Assert.Contains("not the record", ex.Message);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_untrusted_record_says_to_keep_everything_and_never_to_remove_it()
    {
        var captured = await InterruptedReplacement();
        await File.WriteAllTextAsync(JournalOf(captured), "{ this is not json");

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.Contains(Path.GetFileName(JournalOf(captured)), ex.Message);
        Assert.Contains("Keep this record", ex.Message);
        Assert.Contains("new, empty workspace folder", ex.Message);
        Assert.DoesNotContain("move that copy", ex.Message, StringComparison.OrdinalIgnoreCase);
    }
}
