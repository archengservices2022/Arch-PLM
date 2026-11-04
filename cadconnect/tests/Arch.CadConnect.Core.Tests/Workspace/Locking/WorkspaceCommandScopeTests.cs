using System.Runtime.Versioning;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>P6 M4.4 Package C R10: one command admits one operation, proves what it
///  holds before admitting it, and keeps its handles until that operation has
///  ended, whatever else releases it. Real folders and locks unless stated.</summary>
[SupportedOSPlatform("windows")]
public class WorkspaceCommandScopeTests
{
    private const string Origin = "http://localhost:3100";

    private static WorkspaceLockAcquirer Acquirer() => new(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

    private static CommandLock Admit(WorkspaceLockRequest request) =>
        new CommandLockGate(Acquirer(), null).Admit(request, () => true).Lock!;

    private static InvalidOperationException Refused(WorkspaceLockRefusal refusal) => new(refusal.ErrorCode);

    /// <summary>Runs an operation exactly as the orchestrators do.</summary>
    private static Task<int> Operation(WorkspaceLockRequest request, Func<Task<int>>? body = null) =>
        WorkspaceCommandScope.RunAsync(request, () => { }, body ?? (() => Task.FromResult(1)), Refused);

    private static bool CanLockFromOutside(WorkspaceLockRequest request)
    {
        var attempt = Acquirer().TryAcquire(request);
        attempt.Lease?.Dispose();
        return attempt.Acquired;
    }

    // ---- what admission proves --------------------------------------------------

    [Fact]
    public async Task The_operation_a_command_was_locked_for_runs_under_that_lock()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);
        var outsideDuring = true;

        await held.RunAsync(async _ => await Operation(request, () =>
        {
            outsideDuring = CanLockFromOutside(request);
            return Task.FromResult(1);
        }), CancellationToken.None);

        Assert.False(outsideDuring);
        Assert.True(held.IsReleased);
        Assert.True(CanLockFromOutside(request));
    }

    [Fact]
    public async Task The_same_file_through_a_junction_alias_is_the_same_target()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");
        var alias = tree.Junction("Alias", ws);
        var held = Admit(WorkspaceLockRequest.ForDocument("Checkout", part));

        await held.RunAsync(async _ => await Operation(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(alias, "a.ipt"))), CancellationToken.None);

        Assert.True(held.IsReleased);
    }

    [Fact]
    public async Task Another_file_or_another_kind_of_command_is_refused()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");
        var other = tree.File(@"WS\b.ipt");

        foreach (var wrong in new[] { WorkspaceLockRequest.ForDocument("Checkout", other), WorkspaceLockRequest.ForGetLatest("Get Latest", ws) })
        {
            var held = Admit(WorkspaceLockRequest.ForDocument("Checkout", part));
            await held.RunAsync(async _ =>
            {
                var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => Operation(wrong));
                Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, ex.Message);
            }, CancellationToken.None);
        }
    }

    [Fact]
    public void A_root_replaced_after_the_lock_is_refused()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var request = WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt");
        var held = new CommandLockGate(new WorkspaceLockAcquirer(fs, new FakeLockHandleFactory()), null).Admit(request, () => true).Lock!;

        fs.Replace(@"D:\WS");

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(request)!.ErrorCode);
    }

    [Fact]
    public void A_root_that_needs_recovery_after_the_lock_is_refused()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var request = WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt");
        var held = new CommandLockGate(new WorkspaceLockAcquirer(fs, new FakeLockHandleFactory()), null).Admit(request, () => true).Lock!;

        fs.Manifests[@"D:\WS"] = WorkspaceBindingSnapshot.RecoveryRequired;

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceRecoveryRequired, held.TryBorrow(request)!.ErrorCode);
    }

    [Fact]
    public void A_shared_hold_admits_nothing()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var source = tree.File(@"WS\a.ipt");
        var loose = tree.Dir("Out");
        var request = WorkspaceLockRequest.ForCopyDesign("Copy", Origin, "key", new[] { source }, new[] { Path.Combine(loose, "b.ipt") });
        var held = Admit(request);

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(WorkspaceLockRequest.ForDocument("Checkout", source))!.ErrorCode);

        held.Release();
    }

    [Fact]
    public async Task A_root_that_did_not_exist_at_planning_is_identified_once_held()
    {
        using var tree = new TempTree();
        var root = Path.Combine(tree.Root, "New");
        var request = WorkspaceLockRequest.ForGetLatest("Get Latest", root);
        var held = Admit(request);

        await held.RunAsync(async _ => await Operation(request), CancellationToken.None);

        Assert.True(held.IsReleased);
        Assert.True(Directory.Exists(root));
    }

    // ---- one admission, ever ------------------------------------------------------

    [Fact]
    public void Of_two_simultaneous_borrows_exactly_one_is_admitted()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));

        for (var round = 0; round < 40; round++)
        {
            var held = Admit(request);
            var results = new WorkspaceLockRefusal?[2];
            Parallel.For(0, 2, i => results[i] = held.TryBorrow(request));

            Assert.Single(results, r => r is null);
            held.EndAdmission();
            held.Release();
        }
    }

    [Fact]
    public async Task A_second_operation_after_the_first_ended_is_refused_and_never_self_acquires()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);

        await held.RunAsync(async _ =>
        {
            await Operation(request);
            var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => Operation(request));
            Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, ex.Message);
        }, CancellationToken.None);
    }

    [Fact]
    public async Task A_sibling_started_inside_an_operation_is_refused_and_the_operation_finishes()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);
        string? sibling = null;

        await held.RunAsync(async _ => await Operation(request, async () =>
        {
            sibling = (await Record.ExceptionAsync(() => Task.Run(() => Operation(request))))?.Message;
            return 1;
        }), CancellationToken.None);

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, sibling);
    }

    [Fact]
    public async Task A_self_acquired_operation_is_that_commands_one_admission()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        string? nested = null;

        await Operation(request, async () =>
        {
            nested = (await Record.ExceptionAsync(() => Operation(request)))?.Message;
            return 1;
        });

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, nested);
        Assert.True(CanLockFromOutside(request));
    }

    [Fact]
    public async Task A_refused_borrow_spends_the_admission()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");
        var other = tree.File(@"WS\b.ipt");
        var request = WorkspaceLockRequest.ForDocument("Checkout", part);
        var held = Admit(request);

        await held.RunAsync(async _ =>
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => Operation(WorkspaceLockRequest.ForDocument("Checkout", other)));
            await Assert.ThrowsAsync<InvalidOperationException>(() => Operation(request));
        }, CancellationToken.None);
    }

    // ---- lifetime ------------------------------------------------------------------

    [Fact]
    public async Task A_task_that_outlives_its_command_is_refused_and_never_self_acquires()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);
        var commandEnded = new TaskCompletionSource();
        Task<Exception?>? late = null;

        await held.RunAsync(_ =>
        {
            late = Task.Run<Exception?>(async () =>
            {
                await commandEnded.Task;
                return await Record.ExceptionAsync(() => Operation(request));
            });
            return Task.CompletedTask;
        }, CancellationToken.None);
        commandEnded.SetResult();

        var ex = await late!;
        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, ex!.Message);
        Assert.True(CanLockFromOutside(request));
    }

    [Fact]
    public async Task With_no_ambient_scope_because_flow_was_suppressed_the_operation_finds_the_lock_held_and_is_refused()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);
        Exception? suppressed = null;

        await held.RunAsync(async _ =>
        {
            Task task;
            using (ExecutionContext.SuppressFlow())
            {
                task = Task.Run(async () => suppressed = await Record.ExceptionAsync(() => Operation(request)));
            }
            await task;
        }, CancellationToken.None);

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, suppressed!.Message);
    }

    [Fact]
    public async Task Handles_outlast_a_release_until_the_admitted_operation_ends()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);
        var started = new TaskCompletionSource();
        var finish = new TaskCompletionSource();
        Task? detached = null;

        await held.RunAsync(_ =>
        {
            detached = Task.Run(() => Operation(request, async () =>
            {
                started.SetResult();
                await finish.Task;
                return 1;
            }));
            return started.Task;
        }, CancellationToken.None);

        Assert.False(held.IsReleased);
        Assert.False(held.Lease.IsReleased);
        Assert.False(CanLockFromOutside(request));

        finish.SetResult();
        await detached!;

        Assert.True(held.IsReleased);
        Assert.True(CanLockFromOutside(request));
    }

    [Fact]
    public async Task Disposing_the_public_lease_during_an_operation_keeps_every_handle_until_it_ends()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);
        var outsideDuring = true;

        await held.RunAsync(async _ => await Operation(request, () =>
        {
            held.Lease.Dispose();
            held.Lease.Dispose();
            outsideDuring = CanLockFromOutside(request);
            return Task.FromResult(1);
        }), CancellationToken.None);

        Assert.False(outsideDuring);
        Assert.True(held.Lease.IsReleased);
        Assert.True(CanLockFromOutside(request));
    }

    [Fact]
    public void Disposing_a_lease_outside_any_operation_releases_it_at_once_and_ends_the_command()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var held = Admit(request);

        held.Lease.Dispose();

        Assert.True(held.IsReleased);
        Assert.True(held.Lease.IsReleased);
        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(request)!.ErrorCode);
    }

    [Fact]
    public void A_borrow_racing_a_release_is_either_refused_or_keeps_the_handles_until_it_ends()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));

        for (var round = 0; round < 40; round++)
        {
            var held = Admit(request);
            WorkspaceLockRefusal? refusal = null;
            Parallel.Invoke(() => refusal = held.TryBorrow(request), held.Release);

            if (refusal is null)
            {
                Assert.False(held.Lease.IsReleased);
                held.EndAdmission();
                held.Release();
            }
            Assert.True(held.Lease.IsReleased);
        }
    }

    [Fact]
    public async Task The_previous_scope_is_restored_after_success_failure_and_cancellation()
    {
        using var tree = new TempTree();
        tree.Workspace("A", Origin);
        tree.Workspace("B", Origin);
        var part = tree.File(@"A\a.ipt");
        var outer = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"B\b.ipt"));
        var held = Admit(outer);

        await held.RunAsync(async _ =>
        {
            foreach (var work in new Func<CancellationToken, Task>[]
            {
                _ => Task.CompletedTask,
                _ => throw new IOException("failed"),
                ct => throw new OperationCanceledException(ct),
            })
            {
                var inner = Admit(WorkspaceLockRequest.ForDocument("Checkout", part));
                await Record.ExceptionAsync(() => inner.RunAsync(work, CancellationToken.None));

                Assert.Same(held, WorkspaceCommandScope.Current);
                Assert.True(inner.IsReleased);
            }
        }, CancellationToken.None);

        Assert.Null(WorkspaceCommandScope.Current);
    }

    [Fact]
    public async Task A_guard_refusal_outside_any_command_leaves_no_lock_artifact()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");

        await Assert.ThrowsAsync<IOException>(() => WorkspaceCommandScope.RunAsync<int>(
            WorkspaceLockRequest.ForDocument("Checkout", part), () => throw new IOException("refused"), () => Task.FromResult(1), Refused));

        Assert.False(Directory.Exists(Path.Combine(ws, ".arch", "locks")));
    }

    [Fact]
    public async Task A_guard_that_fails_once_locked_releases_the_lock()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));
        var calls = 0;

        await Assert.ThrowsAsync<IOException>(() => WorkspaceCommandScope.RunAsync<int>(request, () =>
        {
            if (++calls == 2)
            {
                throw new IOException("changed");
            }
        }, () => Task.FromResult(1), Refused));

        Assert.True(CanLockFromOutside(request));
    }
}
