using System.Security.AccessControl;
using System.Security.Principal;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R8: from its verification to its save the manifest
///  cannot be changed by anyone, and a recovery record goes only while the copy's
///  name is held.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private string SomeoneElsesManifest => Path.Combine(_root, "someone-elses.json");

    private string[] SetAsideManifests() => Directory.GetFiles(ArchPath, "workspace.json.*.previous");

    private async Task<WorkspaceManifest> CheckedOutManifest()
    {
        await CheckedOutPart();
        return WorkspaceManifest.Load(_root).Manifest;
    }

    // ---- a competing writer, precisely between verification and replacement -----

    public static TheoryData<string> CompetingWrites => new()
    {
        "write in place",
        "move over it",
        "replace it",
        "rename it away",
        "delete it",
    };

    private void Compete(string how)
    {
        File.WriteAllText(SomeoneElsesManifest, ForeignManifest);
        switch (how)
        {
            case "write in place": File.WriteAllText(ManifestPath, ForeignManifest); break;
            case "move over it": File.Move(SomeoneElsesManifest, ManifestPath, overwrite: true); break;
            case "replace it": File.Replace(SomeoneElsesManifest, ManifestPath, null); break;
            case "rename it away": File.Move(ManifestPath, ManifestPath + ".away"); break;
            case "delete it": File.Delete(ManifestPath); break;
        }
    }

    [Theory]
    [MemberData(nameof(CompetingWrites))]
    [Trait("PackageC", "Policy")]
    public async Task A_competing_writer_cannot_touch_a_verified_manifest_before_it_is_replaced(string how)
    {
        var manifest = await CheckedOutManifest();
        Exception? competing = null;

        manifest.SaveIfUnchangedSinceLoad(At(ManifestSaveStep.Verified, () => competing = Record.Exception(() => Compete(how))));

        Assert.NotNull(competing);
        Assert.NotNull(Entry(PartPath).Checkout);
        Assert.False(File.Exists(ManifestPath + ".away"));
        Assert.Empty(SetAsideManifests());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_competing_writer_in_a_new_workspace_is_never_overwritten()
    {
        Directory.CreateDirectory(ArchPath);
        var manifest = WorkspaceManifest.Load(_root).Manifest;

        Assert.Throws<WorkspaceManifestChangedException>(() =>
            manifest.SaveIfUnchangedSinceLoad(At(ManifestSaveStep.Verified, () => File.WriteAllText(ManifestPath, ForeignManifest))));

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_placed_at_the_empty_path_during_a_save_is_kept_with_the_verified_manifest_beside_it()
    {
        var manifest = await CheckedOutManifest();
        var before = await File.ReadAllBytesAsync(ManifestPath);

        Assert.Throws<WorkspaceManifestChangedException>(() =>
            manifest.SaveIfUnchangedSinceLoad(At(ManifestSaveStep.SetAside, () => File.WriteAllText(ManifestPath, ForeignManifest))));

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.Equal(before, await File.ReadAllBytesAsync(Assert.Single(SetAsideManifests())));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    // ---- every state the manifest can be in at the save -------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_unchanged_manifest_is_saved_and_leaves_nothing_beside_it()
    {
        var manifest = await CheckedOutManifest();

        manifest.SaveIfUnchangedSinceLoad();

        Assert.NotNull(Entry(PartPath).Checkout);
        Assert.Empty(SetAsideManifests());
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_modified_before_verification_is_left_as_it_is()
    {
        var manifest = await CheckedOutManifest();
        await File.WriteAllTextAsync(ManifestPath, ForeignManifest);

        Assert.Throws<WorkspaceManifestChangedException>(() => manifest.SaveIfUnchangedSinceLoad());

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
        Assert.Empty(SetAsideManifests());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_replaced_by_a_different_file_before_verification_is_left_as_it_is()
    {
        var manifest = await CheckedOutManifest();
        await File.WriteAllTextAsync(SomeoneElsesManifest, ForeignManifest);
        File.Move(SomeoneElsesManifest, ManifestPath, overwrite: true);

        Assert.Throws<WorkspaceManifestChangedException>(() => manifest.SaveIfUnchangedSinceLoad());

        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_deleted_before_verification_is_not_written_back()
    {
        var manifest = await CheckedOutManifest();
        File.Delete(ManifestPath);

        Assert.Throws<WorkspaceManifestChangedException>(() => manifest.SaveIfUnchangedSinceLoad());

        Assert.False(File.Exists(ManifestPath));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_held_open_elsewhere_is_left_as_it_is()
    {
        var manifest = await CheckedOutManifest();
        var before = await File.ReadAllBytesAsync(ManifestPath);

        using (new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            Assert.Throws<WorkspaceManifestPersistException>(() => manifest.SaveIfUnchangedSinceLoad());
        }

        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_with_a_second_name_cannot_be_held_and_is_left_as_it_is()
    {
        var manifest = await CheckedOutManifest();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var alias = Path.Combine(_root, "second-name.json");
        Assert.True(CreateHardLink(alias, ManifestPath, IntPtr.Zero));

        Assert.Throws<WorkspaceManifestPersistException>(() => manifest.SaveIfUnchangedSinceLoad());

        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        Assert.Equal(before, await File.ReadAllBytesAsync(alias));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_the_user_cannot_access_is_left_as_it_is()
    {
        var manifest = await CheckedOutManifest();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var info = new FileInfo(ManifestPath);
        var denial = new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.ReadData | FileSystemRights.Delete, AccessControlType.Deny);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(denial);
        info.SetAccessControl(acl);
        try
        {
            Assert.Throws<WorkspaceManifestPersistException>(() => manifest.SaveIfUnchangedSinceLoad());
        }
        finally
        {
            acl.RemoveAccessRule(denial);
            info.SetAccessControl(acl);
        }

        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        Assert.Empty(Directory.GetFiles(ArchPath, "*.tmp"));
    }

    // ---- a save that never finished ---------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_manifest_set_aside_beside_a_current_one_refuses_and_changes_neither()
    {
        await CheckedOutPart();
        var set = ManifestPath + ".0123.previous";
        await File.WriteAllTextAsync(set, ForeignManifest);
        var before = await File.ReadAllBytesAsync(ManifestPath);
        var handler = Server(RootPart);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Contains(Path.GetFileName(set), ex.Message);
        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
        Assert.Equal(ForeignManifest, await File.ReadAllTextAsync(set));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Two_manifests_set_aside_with_nothing_at_the_path_refuses_and_restores_neither()
    {
        await CheckedOutPart();
        File.Move(ManifestPath, ManifestPath + ".0123.previous");
        await File.WriteAllTextAsync(ManifestPath + ".4567.previous", ForeignManifest);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));

        Assert.False(File.Exists(ManifestPath));
        Assert.Equal(2, SetAsideManifests().Length);
    }

    // ---- a record goes only while the copy's name is held ------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_that_appears_right_after_its_absence_was_seen_keeps_its_record_at_restart()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        var elsewhere = Path.Combine(_root, "kept-elsewhere.ipt");
        File.Move(copy, elsewhere);
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, readCopyAttributes: path =>
        {
            File.Move(elsewhere, path);
            throw new FileNotFoundException();
        });

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1", materializer: materializer));

        Assert.True(File.Exists(JournalOf(captured)));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Nothing_can_take_a_copys_name_while_its_record_is_removed_at_restart()
    {
        var captured = await InterruptedReplacement();
        var copy = CopyOf(captured);
        var elsewhere = Path.Combine(_root, "kept-elsewhere.ipt");
        File.Move(copy, elsewhere);
        Exception? competing = null;
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, whileClearingRecord: path =>
            competing = Record.Exception(() => File.Move(elsewhere, path)));

        await Run(Server(RootPart), "PRT-1", materializer: materializer);

        Assert.NotNull(competing);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(elsewhere));
        Assert.Empty(RecoveryJournals());
        Assert.False(File.Exists(copy));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Nothing_can_take_a_copys_name_while_its_record_is_removed_after_a_live_cleanup()
    {
        await CheckedOutPart();
        Exception? competing = null;
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, whileClearingRecord: path =>
            competing = Record.Exception(() => File.WriteAllBytes(path, EditedBytes)));

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        Assert.NotNull(competing);
        Assert.Null(report.Results.Single().Reason);
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_record_that_cannot_be_removed_stays_and_the_name_is_released()
    {
        var captured = await InterruptedReplacement();
        File.Move(CopyOf(captured), Path.Combine(_root, "kept-elsewhere.ipt"));

        using (new FileStream(JournalOf(captured), FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));
        }

        Assert.True(File.Exists(JournalOf(captured)));
        Assert.False(File.Exists(CopyOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_that_appears_right_after_a_live_cleanup_keeps_its_record_and_is_reported()
    {
        await CheckedOutPart();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, readCopyAttributes: path =>
        {
            File.WriteAllBytes(path, EditedBytes);
            throw new FileNotFoundException();
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        var copy = Assert.Single(RecoveryFiles());
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(copy));
        Assert.Single(RecoveryJournals());
        Assert.Contains(Path.GetFileName(copy), report.Results.Single().Reason);
    }
}
