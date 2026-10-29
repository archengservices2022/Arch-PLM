using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.CopyDesign;

/// <summary>
/// P6 Milestone 3: source-level guards for the COM-only / wiring parts of
/// OldVersions backup protection (no Inventor test harness exists - see
/// <c>InventorCopyDesignPhysicalCopierSourceGuardTests</c>).
/// </summary>
public class CopyDesignBackupTrackingSourceGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "Arch.CadConnect.sln")))
        {
            dir = dir.Parent;
        }
        return dir?.FullName ?? throw new InvalidOperationException("Repository root (Arch.CadConnect.sln) not found.");
    }

    private static string Code(params string[] relative) =>
        Regex.Replace(File.ReadAllText(Path.Combine(new[] { RepoRoot(), "src" }.Concat(relative).ToArray())), @"//.*$", "", RegexOptions.Multiline);

    [Fact]
    public void The_IAM_rewirer_saves_ONLY_the_copied_assembly_never_its_dependents()
    {
        var code = Code("Arch.CadConnect.Inventor", "CopyDesign", "InventorCopyDesignReferenceRewirer.cs");

        Assert.Contains("document.Save2(SaveDependents: false, DocumentsToSave: Type.Missing);", code, StringComparison.Ordinal);
        Assert.DoesNotContain(".Save()", code, StringComparison.Ordinal);
        Assert.DoesNotContain("SaveDependents: true", code, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("InventorCopyDesignReferenceRewirer.cs")]
    [InlineData("InventorCopyDesignDrawingReferenceRewirer.cs")]
    [InlineData("InventorCopyDesignMetadataNormalizer.cs")]
    public void Every_Copy_Design_save_of_an_existing_destination_uses_Save2_without_dependents(string file)
    {
        var code = Code("Arch.CadConnect.Inventor", "CopyDesign", file);

        Assert.Matches(@"\.Save2\(SaveDependents: false", code);
        Assert.DoesNotContain(".Save()", code, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_attempt_owned_save_in_the_orchestrator_is_wrapped_in_backup_tracking()
    {
        var code = Code("Arch.CadConnect.Core", "CopyDesign", "Apply", "CopyDesignApplyOrchestrator.cs");

        // model normalizer, IAM rewirer, drawing normalizer, drawing rewirer
        Assert.Equal(4, Regex.Matches(code, @"await RunTrackedSaveAsync\(").Count);
        Assert.Contains("() => rewirer.RewireAsync(", code, StringComparison.Ordinal);
        Assert.Contains("() => drawingRewirer!.RewireAsync(", code, StringComparison.Ordinal);
        Assert.Equal(2, Regex.Matches(code, @"\(\) => NormalizeMetadataAsync\(").Count);
        // No adapter save is ever called outside the wrapper.
        Assert.Single(Regex.Matches(code, @"rewirer\.RewireAsync\("));
        Assert.Single(Regex.Matches(code, @"drawingRewirer!\.RewireAsync\("));
        // Every cleanup goes through CleanUpAttempt (destinations + owned backups).
        Assert.Single(Regex.Matches(code, @"CopyDesignCleanupPlanner\.CleanUp\("));
    }

    [Fact]
    public void Backup_tracking_never_deletes_a_directory_or_changes_Inventor_backup_settings()
    {
        var core = Code("Arch.CadConnect.Core", "CopyDesign", "Apply", "CopyDesignBackupTracking.cs");
        var orchestrator = Code("Arch.CadConnect.Core", "CopyDesign", "Apply", "CopyDesignApplyOrchestrator.cs");

        foreach (var code in new[] { core, orchestrator })
        {
            Assert.DoesNotContain("Directory.Delete", code, StringComparison.Ordinal);
            Assert.DoesNotContain("OldVersionsToKeep", code, StringComparison.Ordinal);
        }
        Assert.Single(Regex.Matches(core, @"File\.Delete\("));
    }

    [Fact]
    public void The_production_apply_path_wires_the_real_backup_file_system()
    {
        var controller = Code("Arch.CadConnect.Inventor", "ArchAddInController.cs");
        var start = controller.IndexOf("private void ExecuteCopyDesignAttempt(", StringComparison.Ordinal);
        var end = controller.IndexOf("\n    private ", start + 10, StringComparison.Ordinal);

        Assert.Contains("backupFileSystem: new Core.CopyDesign.Apply.CopyDesignBackupFileSystem()", controller[start..end], StringComparison.Ordinal);
    }
}
