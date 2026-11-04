using System.Runtime.Versioning;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: acquire-all-or-release in plan order, revalidation under the
/// locks, and a lease that releases every handle exactly once - with a
/// scripted factory, and against real folders swapped or re-bound between
/// validation and acquisition.
/// </summary>
public class WorkspaceLockAcquirerTests
{
    private const string Origin = "http://localhost:3100";

    private static (FakeLockPathSystem Fs, WorkspaceLockRequest Request) CopyDesignScenario()
    {
        var fs = new FakeLockPathSystem()
            .Workspace(@"D:\Src").File(@"D:\Src\a.ipt").Workspace(@"D:\DestWS").Dir(@"D:\Out");
        return (fs, WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-1",
            new[] { @"D:\Src\a.ipt" }, new[] { @"D:\Out\a2.ipt", @"D:\DestWS\b2.ipt" }));
    }

    [Fact]
    public void Locks_are_taken_in_plan_order_and_released_in_reverse_exactly_once()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory();
        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(request);

        Assert.True(acquisition.Acquired);
        Assert.Equal(new[]
        {
            "Operation:http://localhost:3100|key-1",
            @"Destination:D:\OUT",
            @"W:Exclusive:D:\DestWS",
            @"W:Shared:D:\Src",
        }, factory.Calls);
        Assert.Empty(factory.Released);

        acquisition.Lease!.Dispose();
        acquisition.Lease.Dispose();

        Assert.True(acquisition.Lease.IsReleased);
        Assert.Equal(factory.Calls.AsEnumerable().Reverse(), factory.Released);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void A_refused_lock_releases_every_lock_already_taken_and_takes_no_more(int refusedIndex)
    {
        var (fs, request) = CopyDesignScenario();
        var keys = new[] { "http://localhost:3100|key-1", @"D:\OUT", @"D:\DestWS", @"D:\Src" };
        var scopes = new[] { LockScope.Operation, LockScope.Destination, LockScope.Workspace, LockScope.Workspace };
        var factory = new FakeLockHandleFactory();
        factory.RefuseKeys[keys[refusedIndex]] = WorkspaceLockErrorCodes.LockedFor(scopes[refusedIndex]);

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(request);

        Assert.False(acquisition.Acquired);
        Assert.Equal(refusedIndex + 1, factory.Calls.Count);
        Assert.Equal(factory.Calls.Take(refusedIndex).Reverse(), factory.Released);
        Assert.Equal(scopes[refusedIndex], acquisition.Refusal!.Scope);
        Assert.Equal(WorkspaceLockErrorCodes.LockedFor(scopes[refusedIndex]), acquisition.Refusal.ErrorCode);
        Assert.Equal(refusedIndex == 0 ? "key-1" : null, acquisition.Refusal.IdempotencyKey);
    }

    [Fact]
    public void An_exception_while_acquiring_releases_what_was_taken_and_propagates()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory { ThrowOnAcquireKey = @"D:\DestWS" };

        Assert.Throws<IOException>(() => new WorkspaceLockAcquirer(fs, factory).TryAcquire(request));
        Assert.Equal(factory.Calls.Take(2).Reverse(), factory.Released);
    }

    [Fact]
    public void A_failing_release_is_counted_and_never_skips_the_other_handles()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory();
        factory.ThrowOnRelease.Add(@"Destination:D:\OUT");
        var lease = new WorkspaceLockAcquirer(fs, factory).TryAcquire(request).Lease!;

        lease.Dispose();

        Assert.Equal(4, factory.Released.Count);
        Assert.Equal(1, lease.FailedReleases);
        Assert.True(lease.IsReleased);
    }

    [Fact]
    public void Concurrent_disposal_releases_each_handle_once()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory();
        var lease = new WorkspaceLockAcquirer(fs, factory).TryAcquire(request).Lease!;

        Parallel.For(0, 16, _ => lease.Dispose());

        Assert.Equal(4, factory.Released.Count);
    }

    [Fact]
    public void A_change_found_after_acquisition_releases_every_lock_and_refuses()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var factory = new FakeLockHandleFactory();
        // Between validation and acquisition another process re-binds the workspace.
        factory.OnAcquired = () => fs.Workspace(@"D:\WS", "http://localhost:3000");

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt"));

        Assert.False(acquisition.Acquired);
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceChanged, acquisition.Refusal!.ErrorCode);
        Assert.Equal(factory.Calls, factory.Released);
    }

    [Fact]
    public void An_interruption_between_planning_and_acquisition_releases_every_lock_and_refuses()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var factory = new FakeLockHandleFactory();
        factory.OnAcquired = () => fs.Manifests[@"D:\WS"] = WorkspaceBindingSnapshot.RecoveryRequired;

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt"));

        Assert.False(acquisition.Acquired);
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, acquisition.Refusal!.ErrorCode);
        Assert.Equal(factory.Calls, factory.Released);
    }

    [Fact]
    public void A_workspace_already_interrupted_at_planning_takes_no_lock_at_all()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        fs.Manifests[@"D:\WS"] = WorkspaceBindingSnapshot.RecoveryRequired;
        var factory = new FakeLockHandleFactory();

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt"));

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, acquisition.Refusal!.ErrorCode);
        Assert.Empty(factory.Calls);
    }

    [Fact]
    public void An_interrupted_destination_workspace_refuses_Copy_Design_before_any_lock()
    {
        var (fs, request) = CopyDesignScenario();
        fs.Manifests[@"D:\DestWS"] = WorkspaceBindingSnapshot.RecoveryRequired;
        var factory = new FakeLockHandleFactory();

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(request);

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, acquisition.Refusal!.ErrorCode);
        Assert.Empty(factory.Calls);
    }

    [Fact]
    public void An_interrupted_source_workspace_refuses_Copy_Design_before_any_lock()
    {
        var (fs, request) = CopyDesignScenario();
        fs.Manifests[@"D:\Src"] = WorkspaceBindingSnapshot.RecoveryRequired;
        var factory = new FakeLockHandleFactory();

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(request);

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, acquisition.Refusal!.ErrorCode);
        Assert.Empty(factory.Calls);
    }

    [Fact]
    public void The_recovery_refusal_says_what_it_needs_and_that_nothing_happened()
    {
        var message = WorkspaceLockMessages.Describe(new WorkspaceLockRefusal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, Path: @"D:\WS"));

        Assert.Contains("manual recovery", message);
        Assert.Contains("Nothing was sent to the server", message);
    }

    [Fact]
    public void A_planning_refusal_takes_no_lock_at_all()
    {
        var fs = new FakeLockPathSystem().File(@"D:\loose\a.ipt");
        var factory = new FakeLockHandleFactory();

        var acquisition = new WorkspaceLockAcquirer(fs, factory).TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", @"D:\loose\a.ipt"));

        Assert.Equal(WorkspaceLockErrorCodes.NotInWorkspace, acquisition.Refusal!.ErrorCode);
        Assert.Empty(factory.Calls);
    }

    [Fact]
    public void The_holder_is_named_only_when_its_process_is_alive_on_this_machine()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var factory = new FakeLockHandleFactory();
        factory.RefuseKeys[@"D:\WS"] = WorkspaceLockErrorCodes.WorkspaceLocked;
        var acquirer = new WorkspaceLockAcquirer(fs, factory);
        var request = WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt");

        factory.Holder = WorkspaceLockHolderRecord.ForCurrentProcess("Get Latest", LockMode.Exclusive);
        var live = acquirer.TryAcquire(request).Refusal!;
        Assert.Equal(Environment.ProcessId, live.HolderProcessId);
        Assert.Equal("Get Latest", live.Holder!.Command);

        factory.Holder = factory.Holder with { MachineName = "ANOTHER-PC" };
        var remote = acquirer.TryAcquire(request).Refusal!;
        Assert.Null(remote.HolderProcessId);
        Assert.Null(remote.Holder);
    }

    // ---- real folders ----------------------------------------------------------------

    [Fact]
    [SupportedOSPlatform("windows")]
    public void A_workspace_folder_swapped_between_validation_and_acquisition_is_refused()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS");
        tree.File(@"WS\a.ipt");
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);
        var plan = acquirer.Planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(ws, "a.ipt"))).Plan!;

        Directory.Move(ws, ws + "-moved");
        tree.Workspace("WS");
        tree.File(@"WS\a.ipt");

        var acquisition = acquirer.TryAcquire(plan);
        Assert.Equal(WorkspaceLockErrorCodes.PathChanged, acquisition.Refusal!.ErrorCode);
        // and the refused attempt left no lock held
        var after = acquirer.TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(ws, "a.ipt")));
        Assert.True(after.Acquired, after.Refusal?.ErrorCode);
        after.Lease!.Dispose();
    }

    [Fact]
    [SupportedOSPlatform("windows")]
    public void A_manifest_re_bound_between_validation_and_acquisition_is_refused()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS");
        tree.File(@"WS\a.ipt");
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);
        var plan = acquirer.Planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(ws, "a.ipt"))).Plan!;

        tree.Workspace("WS", origin: "http://localhost:3000");

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceChanged, acquirer.TryAcquire(plan).Refusal!.ErrorCode);
    }

    [Fact]
    [SupportedOSPlatform("windows")]
    public void A_new_Get_Latest_folder_is_created_by_its_own_lock_and_still_revalidates()
    {
        using var tree = new TempTree();
        var target = Path.Combine(tree.Root, "NewWS");
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

        var acquisition = acquirer.TryAcquire(WorkspaceLockRequest.ForGetLatest("Get Latest", target));

        Assert.True(acquisition.Acquired, acquisition.Refusal?.ErrorCode);
        Assert.True(File.Exists(WorkspaceFileLock.LockFilePath(target)));
        Assert.False(File.Exists(Path.Combine(target, Core.Workspace.WorkspaceManifest.RelativeManifestPath)));
        acquisition.Lease!.Dispose();
    }
}
