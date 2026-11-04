using System.Diagnostics;
using System.Runtime.Versioning;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Tests.Workspace.Locking;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;
using Xunit.Abstractions;

namespace Arch.CadConnect.Core.Tests.Workspace;

/// <summary>P6 M4.4 Package C R9: a REAL, SEPARATE process saves the manifest with
///  the production code and is terminated at each boundary of the save: no
///  finally block, no Dispose, no cleanup of any kind runs in it. Every line this
///  writes is recorded in the test results as crash evidence.</summary>
[SupportedOSPlatform("windows")]
public sealed class WorkspaceManifestCrashTests(ITestOutputHelper output)
{
    private const string Origin = "http://localhost:3100";

    private static readonly ArchServerUri Server = ArchServerUri.Parse(Origin);

    private static string Manifest(string root) => Path.Combine(root, WorkspaceManifest.RelativeManifestPath);

    private (int ExitCode, string Output) SaveInAChildProcess(string root, string terminateAt)
    {
        return SaveInAChildProcess(["manifest-save", root, terminateAt]);
    }

    private (int ExitCode, string Output) SaveInAChildProcess(string[] args)
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "Arch.CadConnect.LockProbe.exe");
        var child = BoundedChild.Run(exe, TimeSpan.FromSeconds(30), args);
        output.WriteLine($"child pid={child.ProcessId} args={args[2]} exit={child.ExitCode} stdout={child.Output.Trim()}");
        Assert.False(child.TimedOut, "the child did not end");
        return (child.ExitCode!.Value, child.Output);
    }

    /// <summary>A workspace with one real entry and no checkout, so the save below
    ///  changes something a test can look for.</summary>
    private static (string Root, string Part, byte[] Old) ChangedManifestWorkspace(TempTree tree)
    {
        var root = tree.Dir("WS");
        var part = tree.File(@"WS\a.ipt");
        var old = System.Text.Encoding.UTF8.GetBytes($$"""
            {"schema":"{{WorkspaceManifest.SchemaId}}","serverOrigin":"{{Origin}}","organizationId":"org-1","entries":[
            {"relativePath":"a.ipt","cadDocumentId":"cad_a","fileVersionId":"fv_a","versionNumber":1,"checksum":"{{new string('b', 64)}}","fileSize":1,"state":"Verified"}]}
            """);
        tree.Dir(@"WS\.arch");
        File.WriteAllBytes(Manifest(root), old);
        return (root, part, old);
    }

    private const string Added = "co_added";

    private static bool Holds(string path) => File.ReadAllText(path).Contains(Added, StringComparison.Ordinal);

    private static string Temporary(string root) => Directory.GetFiles(Path.Combine(root, ".arch"))
        .Single(f => f.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase));

    [Fact]
    public void The_control_a_genuinely_changed_manifest_is_saved_whole()
    {
        using var tree = new TempTree();
        var (root, part, _) = ChangedManifestWorkspace(tree);

        var (exit, _) = SaveInAChildProcess(["manifest-save", root, "none", part, Added]);
        Record(root);

        Assert.Equal(0, exit);
        Assert.True(Holds(Manifest(root)));
        Assert.Equal(Added, WorkspaceManifest.Load(root).Manifest.Entries.Single().Checkout!.CheckoutId);
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
    }

    [Theory]
    [InlineData(nameof(ManifestSaveStep.TemporaryWritten))]
    [InlineData(nameof(ManifestSaveStep.Verified))]
    public void Terminated_before_the_change_moved_the_old_bytes_stand_and_the_change_is_only_in_the_temporary(string step)
    {
        using var tree = new TempTree();
        var (root, part, old) = ChangedManifestWorkspace(tree);

        var (exit, _) = SaveInAChildProcess(["manifest-save", root, step, part, Added]);
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.Equal(old, File.ReadAllBytes(Manifest(root)));
        Assert.True(Holds(Temporary(root)));
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
    }

    [Fact]
    public void Terminated_with_the_path_empty_the_old_and_new_records_are_both_whole_and_distinct()
    {
        using var tree = new TempTree();
        var (root, part, old) = ChangedManifestWorkspace(tree);

        var (exit, _) = SaveInAChildProcess(["manifest-save", root, nameof(ManifestSaveStep.SetAside), part, Added]);
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.False(File.Exists(Manifest(root)));
        Assert.Equal(old, File.ReadAllBytes(SetAside(root)));
        Assert.True(Holds(Temporary(root)));
        AssertRefusedEverywhereAndUnchanged(tree, root);
    }

    [Fact]
    public void Terminated_after_placing_the_new_record_it_carries_the_checkout_and_the_old_one_does_not()
    {
        using var tree = new TempTree();
        var (root, part, old) = ChangedManifestWorkspace(tree);

        var (exit, _) = SaveInAChildProcess(["manifest-save", root, nameof(ManifestSaveStep.Placed), part, Added]);
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.True(Holds(Manifest(root)));
        Assert.Equal(old, File.ReadAllBytes(SetAside(root)));
        Assert.False(Holds(SetAside(root)));
        AssertRefusedEverywhereAndUnchanged(tree, root);
    }

    [Fact]
    public void Terminated_with_the_deletion_marked_only_the_new_record_remains()
    {
        using var tree = new TempTree();
        var (root, part, _) = ChangedManifestWorkspace(tree);

        var (exit, _) = SaveInAChildProcess(["manifest-save", root, nameof(ManifestSaveStep.DeleteMarked), part, Added]);
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.True(Holds(Manifest(root)));
        Assert.False(Exists(root, ".previous"));
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
    }

    [Fact]
    public void A_child_that_hangs_is_killed_on_time_with_its_output_so_far()
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "Arch.CadConnect.LockProbe.exe");
        var watch = Stopwatch.StartNew();

        var child = BoundedChild.Run(exe, TimeSpan.FromSeconds(2), "hang", "partial output");

        Assert.True(child.TimedOut);
        Assert.Contains("partial output", child.Output);
        Assert.InRange(watch.Elapsed, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(20));
    }

    private void Record(string root)
    {
        var inspection = WorkspaceRecoveryState.Inspect(root);
        output.WriteLine($"state={inspection.Status} artifacts=[{string.Join(", ", inspection.Artifacts.Select(a => Path.GetFileName(a)[..Math.Min(15, Path.GetFileName(a).Length)] + "..." + Path.GetExtension(a)))}]");
        output.WriteLine("files=[" + string.Join(", ", Directory.GetFileSystemEntries(Path.Combine(root, ".arch")).Select(e =>
            Path.GetFileName(e)[..Math.Min(15, Path.GetFileName(e).Length)] + "..." + Path.GetExtension(e))) + "]");
    }

    private static string SetAside(string root) => Directory.GetFiles(Path.Combine(root, ".arch"))
        .Single(f => f.EndsWith(".previous", StringComparison.OrdinalIgnoreCase));

    private static bool Exists(string root, string suffix) =>
        Directory.GetFiles(Path.Combine(root, ".arch")).Any(f => f.EndsWith(suffix, StringComparison.OrdinalIgnoreCase));

    /// <summary>Refused by every guard, and nothing was promoted or changed by the
    ///  asking.</summary>
    private static void AssertRefusedEverywhereAndUnchanged(TempTree tree, string root)
    {
        var before = tree.Snapshot();
        Assert.Equal(WorkspaceServerBindingVerdict.RecoveryRequired, WorkspaceServerBinding.CheckGetLatestTarget(root, Server).Verdict);
        Assert.Equal(WorkspaceServerBindingVerdict.RecoveryRequired, WorkspaceServerBinding.CheckWorkspace(root, Server).Verdict);
        Assert.Equal(root, WorkspaceRootLocator.FindRootForFile(Path.Combine(root, "a.ipt")));
        var planned = new WorkspaceLockPlanner(WindowsLockPathSystem.Instance).Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", root));
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, planned.Refusal!.ErrorCode);
        Assert.Equal(before, tree.Snapshot());
    }

    [Fact]
    public void The_control_a_child_that_is_not_terminated_saves_and_leaves_nothing_behind()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);

        var (exit, stdout) = SaveInAChildProcess(root, "none");
        Record(root);

        Assert.Equal(0, exit);
        Assert.Contains("SAVED", stdout);
        Assert.False(Exists(root, ".previous"));
        Assert.False(Exists(root, ".tmp"));
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
    }

    [Theory]
    [InlineData(nameof(ManifestSaveStep.TemporaryWritten))]
    [InlineData(nameof(ManifestSaveStep.Verified))]
    public void Terminated_before_anything_moved_the_old_manifest_stands_and_the_workspace_is_healthy(string step)
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var original = File.ReadAllBytes(Manifest(root));

        var (exit, stdout) = SaveInAChildProcess(root, step);
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.Contains("TERMINATING " + step, stdout);
        Assert.DoesNotContain("SAVED", stdout);
        Assert.Equal(original, File.ReadAllBytes(Manifest(root)));
        Assert.True(Exists(root, ".tmp"));
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
        Assert.True(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);
    }

    [Fact]
    public void Terminated_with_the_path_empty_the_workspace_requires_recovery_and_the_old_bytes_are_whole()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var original = File.ReadAllBytes(Manifest(root));

        var (exit, stdout) = SaveInAChildProcess(root, nameof(ManifestSaveStep.SetAside));
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.DoesNotContain("SAVED", stdout);
        Assert.False(File.Exists(Manifest(root)));
        Assert.Equal(original, File.ReadAllBytes(SetAside(root)));
        AssertRefusedEverywhereAndUnchanged(tree, root);
    }

    [Fact]
    public void Terminated_after_the_new_file_was_placed_the_workspace_requires_recovery_and_both_stand()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var original = File.ReadAllBytes(Manifest(root));

        var (exit, stdout) = SaveInAChildProcess(root, nameof(ManifestSaveStep.Placed));
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.DoesNotContain("SAVED", stdout);
        Assert.Equal(original, File.ReadAllBytes(SetAside(root)));
        Assert.Equal(WorkspaceManifestLoadStatus.Loaded, WorkspaceManifest.Load(root).Status);
        AssertRefusedEverywhereAndUnchanged(tree, root);
    }

    [Fact]
    public void Terminated_with_the_deletion_marked_Windows_finishes_it_and_the_new_manifest_stands()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);

        var (exit, stdout) = SaveInAChildProcess(root, nameof(ManifestSaveStep.DeleteMarked));
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.DoesNotContain("SAVED", stdout);
        Assert.False(Exists(root, ".previous"));
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
        Assert.Equal(WorkspaceManifestLoadStatus.Loaded, WorkspaceManifest.Load(root).Status);
    }

    [Fact]
    public void Terminated_during_a_first_save_the_folder_requires_recovery_not_a_fresh_start()
    {
        using var tree = new TempTree();
        var root = tree.Dir("WS");
        tree.Dir(@"WS\.arch");

        var (exit, stdout) = SaveInAChildProcess(root, nameof(ManifestSaveStep.TemporaryWritten));
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.DoesNotContain("SAVED", stdout);
        Assert.False(File.Exists(Manifest(root)));
        Assert.True(Exists(root, ".tmp"));
        AssertRefusedEverywhereAndUnchanged(tree, root);
    }

    [Fact]
    public void Terminated_just_after_a_first_save_placed_its_file_the_workspace_is_healthy()
    {
        using var tree = new TempTree();
        var root = tree.Dir("WS");
        tree.Dir(@"WS\.arch");

        var (exit, _) = SaveInAChildProcess(root, nameof(ManifestSaveStep.Placed));
        Record(root);

        Assert.NotEqual(0, exit);
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(root).Status);
    }
}
