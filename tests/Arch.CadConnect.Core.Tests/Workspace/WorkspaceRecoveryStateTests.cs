using System.Runtime.Versioning;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Tests.Workspace.Locking;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace;

/// <summary>P6 M4.4 Package C R9: a workspace whose manifest save did not end
///  cleanly is neither new nor healthy to anything that asks: admission,
///  discovery, the lock planner or its revalidation. Real folders throughout.</summary>
[SupportedOSPlatform("windows")]
public sealed class WorkspaceRecoveryStateTests
{
    private const string RecoveryRequiredCode = "workspace-recovery-required";
    private const string Origin = "http://localhost:3100";
    private const string Op = "0123456789abcdef0123456789abcdef";

    private static readonly ArchServerUri Server = ArchServerUri.Parse(Origin);

    private static string Arch(string root) => Path.Combine(root, ".arch");

    private static string Manifest(string root) => Path.Combine(root, WorkspaceManifest.RelativeManifestPath);

    public static TheoryData<string> InterruptedStates => new()
    {
        "path empty with the old manifest aside",
        "old manifest left beside the new one",
        "only a recognized temporary, nothing at the path",
        "unknown suffix",
        "unfamiliar temporary name",
        "temporary name in the wrong shape",
        "temporary beside an unreadable manifest",
        "name differing only in case",
        "name sharing the manifest prefix",
        "artifact that is a directory",
        "manifest that is a directory",
    };

    private static void Interrupt(string how, string root)
    {
        var manifest = Manifest(root);
        var arch = Arch(root);
        switch (how)
        {
            case "path empty with the old manifest aside":
                File.Move(manifest, $"{manifest}.{Op}.previous");
                break;
            case "old manifest left beside the new one":
                File.Copy(manifest, $"{manifest}.{Op}.previous");
                break;
            case "only a recognized temporary, nothing at the path":
                File.Move(manifest, $"{manifest}.{Op}.tmp");
                break;
            case "unknown suffix":
                File.WriteAllText(manifest + ".bak", "?");
                break;
            case "unfamiliar temporary name":
                File.WriteAllText(manifest + ".tmp", "?");
                break;
            case "temporary name in the wrong shape":
                File.WriteAllText($"{manifest}.NOT-AN-OPERATION.tmp", "?");
                break;
            case "temporary beside an unreadable manifest":
                File.WriteAllText(manifest, "{ torn");
                File.WriteAllText($"{manifest}.{Op}.tmp", "?");
                break;
            case "name differing only in case":
                File.WriteAllText(Path.Combine(arch, $"WORKSPACE.JSON.{Op}.PREVIOUS"), "?");
                break;
            case "name sharing the manifest prefix":
                File.WriteAllText(manifest + "~", "?");
                break;
            case "artifact that is a directory":
                Directory.CreateDirectory($"{manifest}.{Op}.previous");
                break;
            case "manifest that is a directory":
                File.Delete(manifest);
                Directory.CreateDirectory(manifest);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(how));
        }
    }

    private static string RefusalFor(WorkspaceLockRequest request)
    {
        var planned = new WorkspaceLockPlanner(WindowsLockPathSystem.Instance).Plan(request);
        Assert.Null(planned.Plan);
        return planned.Refusal!.ErrorCode;
    }

    [Theory]
    [MemberData(nameof(InterruptedStates))]
    public void An_interrupted_workspace_is_never_admitted_as_new_or_healthy(string how)
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        Interrupt(how, root);
        var before = tree.Snapshot();

        Assert.False(WorkspaceServerBinding.CheckGetLatestTarget(root, Server).Allowed);
        Assert.False(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);
        Assert.Equal(before, tree.Snapshot());
    }

    [Theory]
    [MemberData(nameof(InterruptedStates))]
    public void An_interrupted_workspace_is_still_found_by_discovery(string how)
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        Interrupt(how, root);

        Assert.Equal(root, WorkspaceRootLocator.FindRootForFile(Path.Combine(root, "sub", "a.ipt")));
        Assert.True(WindowsLockPathSystem.Instance.HasManifest(root));
    }

    [Theory]
    [MemberData(nameof(InterruptedStates))]
    public void The_lock_planner_refuses_every_command_on_an_interrupted_workspace(string how)
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");
        var loose = tree.Dir("Out");
        Interrupt(how, root);
        var before = tree.Snapshot();

        Assert.Equal(RecoveryRequiredCode, RefusalFor(WorkspaceLockRequest.ForGetLatest("Get Latest", root)));
        Assert.Equal(RecoveryRequiredCode, RefusalFor(WorkspaceLockRequest.ForDocument("Checkout", part)));
        Assert.Equal(RecoveryRequiredCode, RefusalFor(WorkspaceLockRequest.ForCopyDesign(
            "Apply Copy Design", Origin, "key-1", new[] { part }, new[] { Path.Combine(loose, "b.ipt") })));
        Assert.Equal(before, tree.Snapshot());
    }

    [Fact]
    public void A_Copy_Design_destination_inside_an_interrupted_workspace_gets_a_refusal_not_a_folder_lock()
    {
        using var tree = new TempTree();
        var source = tree.Workspace("Src", Origin);
        var part = tree.File(@"Src\a.ipt");
        var destination = tree.Workspace("Dst", Origin);
        tree.Dir(@"Dst\deep\er");
        Interrupt("path empty with the old manifest aside", destination);

        Assert.Equal(RecoveryRequiredCode, RefusalFor(WorkspaceLockRequest.ForCopyDesign(
            "Apply Copy Design", Origin, "key-1", new[] { part }, new[] { Path.Combine(destination, "deep", "er", "b.ipt") })));
        Assert.Equal(destination, WorkspaceRootLocator.FindRootForFile(Path.Combine(destination, "deep", "er", "b.ipt")));
        Assert.NotEqual(source, destination);
    }

    [Fact]
    public void A_target_inside_an_interrupted_workspace_is_nested_not_new()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var inner = tree.Dir(@"WS\inner");
        Interrupt("path empty with the old manifest aside", root);

        Assert.Equal(WorkspaceLockErrorCodes.NestedWorkspace, RefusalFor(WorkspaceLockRequest.ForGetLatest("Get Latest", inner)));
    }

    [Fact]
    public void An_interruption_after_planning_is_refused_by_revalidation_and_leaves_no_lock_held()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);
        var plan = acquirer.Planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", part)).Plan!;

        Interrupt("path empty with the old manifest aside", root);

        Assert.Equal(RecoveryRequiredCode, acquirer.TryAcquire(plan).Refusal!.ErrorCode);
        File.Move($"{Manifest(root)}.{Op}.previous", Manifest(root));
        var after = acquirer.TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", part));
        Assert.True(after.Acquired, after.Refusal?.ErrorCode);
        after.Lease!.Dispose();
    }

    [Fact]
    public void A_junction_named_like_an_artifact_is_interrupted()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var outside = tree.Dir("Outside");
        tree.Junction(Path.Combine("WS", ".arch", $"workspace.json.{Op}.previous"), outside);

        Assert.False(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);
    }

    [Fact]
    public void A_junction_at_the_arch_folder_is_refused_not_followed()
    {
        using var tree = new TempTree();
        var real = tree.Workspace("Elsewhere", Origin);
        var root = tree.Dir("WS");
        tree.Junction(Path.Combine("WS", ".arch"), Arch(real));

        Assert.False(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);
        Assert.False(WorkspaceServerBinding.CheckGetLatestTarget(root, Server).Allowed);
    }

    [Fact]
    public void A_listing_of_the_arch_folder_that_is_denied_is_refused()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var denied = Deny(Arch(root), System.Security.AccessControl.FileSystemRights.ListDirectory);
        try
        {
            Assert.False(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);
            Assert.False(WorkspaceServerBinding.CheckGetLatestTarget(root, Server).Allowed);
            Assert.Equal(root, WorkspaceRootLocator.FindRootForFile(Path.Combine(root, "a.ipt")));
        }
        finally
        {
            denied();
        }
    }

    private static Action Deny(string folder, System.Security.AccessControl.FileSystemRights rights)
    {
        var info = new DirectoryInfo(folder);
        var rule = new System.Security.AccessControl.FileSystemAccessRule(
            System.Security.Principal.WindowsIdentity.GetCurrent().User!, rights, System.Security.AccessControl.AccessControlType.Deny);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(rule);
        info.SetAccessControl(acl);
        return () =>
        {
            acl.RemoveAccessRule(rule);
            info.SetAccessControl(acl);
        };
    }

    // ---- what must stay exactly as it was ------------------------------------------

    [Fact]
    public void A_recognized_temporary_beside_a_valid_manifest_is_ignored_and_never_promoted()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", Origin);
        var leftover = $"{Manifest(root)}.{Op}.tmp";
        File.WriteAllText(leftover, "left by a process that died");
        var before = tree.Snapshot();

        Assert.True(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);
        Assert.True(WorkspaceServerBinding.CheckGetLatestTarget(root, Server).Allowed);
        Assert.Equal(root, WorkspaceRootLocator.FindRootForFile(Path.Combine(root, "a.ipt")));
        Assert.Equal(before, tree.Snapshot());
    }

    [Fact]
    public void A_folder_with_only_lock_files_is_still_new()
    {
        using var tree = new TempTree();
        var root = tree.Dir("WS");
        tree.File(@"WS\.arch\locks\workspace.lock", "");

        Assert.True(WorkspaceServerBinding.CheckGetLatestTarget(root, Server).Allowed);
        Assert.Null(WorkspaceRootLocator.FindRootForFile(Path.Combine(root, "a.ipt")));
    }

    [Fact]
    public void Clearing_the_artifact_by_hand_returns_the_workspace_to_the_ordinary_checks()
    {
        using var tree = new TempTree();
        var root = tree.Workspace("WS", "http://localhost:3000");
        Interrupt("path empty with the old manifest aside", root);
        Assert.False(WorkspaceServerBinding.CheckWorkspace(root, Server).Allowed);

        File.Move($"{Manifest(root)}.{Op}.previous", Manifest(root));

        Assert.Equal(WorkspaceServerBindingVerdict.DifferentServer, WorkspaceServerBinding.CheckWorkspace(root, Server).Verdict);
    }
}
