using System.Runtime.Versioning;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: the locks across REAL, SEPARATE processes (LockProbe runs the
/// production Core classes) - the shared / exclusive matrix, holder-record
/// visibility, release on kill / crash / exit without disposing, alias
/// resolution through a junction, the machine-wide O / D lock including an
/// event created by "another Windows user", and a lease that stays held
/// through garbage collection.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WorkspaceLockCrossProcessTests : IDisposable
{
    private readonly TempTree _tree = new();

    public void Dispose() => _tree.Dispose();

    private string Workspace() => WindowsLockPathSystem.Instance.Resolve(_tree.Workspace("WS")).Canonical;

    private static LockHandleResult Take(string root, LockMode mode) =>
        WorkspaceFileLock.Acquire(root, mode, WorkspaceLockHolderRecord.ForCurrentProcess("test", mode));

    private static void AssertRefused(string root, LockMode mode)
    {
        var result = Take(root, mode);
        result.Handle?.Dispose();
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, result.ErrorCode);
    }

    private static bool CanTake(string root, LockMode mode)
    {
        var result = Take(root, mode);
        result.Handle?.Dispose();
        return result.Held;
    }

    private static string NewKey() => "m44-test-" + Guid.NewGuid().ToString("N");

    // ---- shared / exclusive across processes -----------------------------------

    [Fact]
    public void Another_process_s_exclusive_lock_refuses_both_exclusive_and_shared_here()
    {
        var ws = Workspace();
        var (probe, line) = LockProbeProcess.Run("w", ws, "exclusive");
        using (probe)
        {
            Assert.Equal("HELD", line);
            AssertRefused(ws, LockMode.Exclusive);
            AssertRefused(ws, LockMode.Shared);

            probe.Send("release");
            Assert.Equal("RELEASED", probe.ReadLine());
            Assert.True(CanTake(ws, LockMode.Exclusive));
        }
    }

    [Fact]
    public void Shared_locks_in_two_processes_coexist_and_both_refuse_an_exclusive_one()
    {
        var ws = Workspace();
        var (first, firstLine) = LockProbeProcess.Run("w", ws, "shared");
        var (second, secondLine) = LockProbeProcess.Run("w", ws, "shared");
        using (first)
        using (second)
        {
            Assert.Equal("HELD", firstLine);
            Assert.Equal("HELD", secondLine);
            AssertRefused(ws, LockMode.Exclusive);

            var mine = Take(ws, LockMode.Shared);
            Assert.True(mine.Held, "a third shared holder joins");
            mine.Handle!.Dispose();

            first.Send("release");
            Assert.Equal("RELEASED", first.ReadLine());
            AssertRefused(ws, LockMode.Exclusive);
            second.Send("release");
            Assert.Equal("RELEASED", second.ReadLine());
            Assert.True(CanTake(ws, LockMode.Exclusive));
        }
    }

    [Fact]
    public void A_shared_lock_here_refuses_another_process_s_exclusive_and_admits_its_shared()
    {
        var ws = Workspace();
        var mine = Take(ws, LockMode.Shared);
        Assert.True(mine.Held);
        try
        {
            var (exclusive, exclusiveLine) = LockProbeProcess.Run("w", ws, "exclusive");
            using (exclusive) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.WorkspaceLocked, exclusiveLine);

            var (shared, sharedLine) = LockProbeProcess.Run("w", ws, "shared");
            using (shared) Assert.Equal("HELD", sharedLine);
        }
        finally
        {
            mine.Handle!.Dispose();
        }
    }

    [Fact]
    public void An_exclusive_lock_here_refuses_another_process()
    {
        var ws = Workspace();
        var mine = Take(ws, LockMode.Exclusive);
        try
        {
            foreach (var mode in new[] { "exclusive", "shared" })
            {
                var (probe, line) = LockProbeProcess.Run("w", ws, mode);
                using (probe) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.WorkspaceLocked, line);
            }
        }
        finally
        {
            mine.Handle!.Dispose();
        }
    }

    // ---- metadata visibility -------------------------------------------------------

    [Fact]
    public void Another_process_s_holder_record_is_visible_here_and_a_reader_never_blocks_a_holder()
    {
        var ws = Workspace();
        var (probe, line) = LockProbeProcess.Run("w", ws, "exclusive");
        using (probe)
        {
            Assert.Equal("HELD", line);
            var record = WorkspaceFileLock.ReadHolder(ws);
            Assert.NotNull(record);
            Assert.Equal(probe.Id, record!.ProcessId);
            Assert.Equal("probe", record.Command);
            Assert.True(record.IsLiveOnThisMachine());
            probe.Send("release");
            Assert.Equal("RELEASED", probe.ReadLine());
        }

        // A reader holding the file open (full sharing) does not stop a new holder.
        using var reader = new FileStream(WorkspaceFileLock.LockFilePath(ws), FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var (next, nextLine) = LockProbeProcess.Run("w", ws, "exclusive");
        using (next) Assert.Equal("HELD", nextLine);
    }

    [Fact]
    public void A_record_left_by_a_killed_holder_is_not_live()
    {
        var ws = Workspace();
        var (probe, line) = LockProbeProcess.Run("w", ws, "exclusive");
        using (probe)
        {
            Assert.Equal("HELD", line);
            probe.Kill();
        }

        var stale = WorkspaceFileLock.ReadHolder(ws);
        Assert.NotNull(stale);
        Assert.False(stale!.IsLiveOnThisMachine());
    }

    // ---- release on termination -----------------------------------------------------

    [Theory]
    [InlineData("kill")]
    [InlineData("failfast")]
    [InlineData("exit")]
    public void A_holder_that_dies_without_releasing_frees_its_workspace_lock(string death)
    {
        var ws = Workspace();
        var (probe, line) = LockProbeProcess.Run("w", ws, "exclusive");
        using (probe)
        {
            Assert.Equal("HELD", line);
            AssertRefused(ws, LockMode.Exclusive);

            if (death == "kill") probe.Kill();
            else
            {
                probe.Send(death);
                probe.WaitForExit();
            }

            Assert.True(Eventually.True(() => CanTake(ws, LockMode.Exclusive)), "the OS did not release the dead holder's lock");
        }
    }

    [Theory]
    [InlineData("kill")]
    [InlineData("failfast")]
    public void A_holder_that_dies_frees_its_machine_lock(string death)
    {
        var key = NewKey();
        var (probe, line) = LockProbeProcess.Run("m", "op", key);
        using (probe)
        {
            Assert.Equal("HELD", line);
            Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, MachineNamedLock.Acquire(LockScope.Operation, key).ErrorCode);

            if (death == "kill") probe.Kill();
            else
            {
                probe.Send(death);
                probe.WaitForExit();
            }

            Assert.True(Eventually.True(() =>
            {
                var again = MachineNamedLock.Acquire(LockScope.Operation, key);
                again.Handle?.Dispose();
                return again.Held;
            }), "the OS did not destroy the dead holder's event");
        }
    }

    // ---- machine-wide O / D -------------------------------------------------------------

    [Fact]
    public void A_machine_lock_held_by_another_process_refuses_here_and_the_reverse()
    {
        var key = NewKey();
        var (probe, line) = LockProbeProcess.Run("m", "dst", key);
        using (probe)
        {
            Assert.Equal("HELD", line);
            Assert.Equal(WorkspaceLockErrorCodes.DestinationLocked, MachineNamedLock.Acquire(LockScope.Destination, key).ErrorCode);
            // the same key in the OTHER scope is a different lock
            var other = MachineNamedLock.Acquire(LockScope.Operation, key);
            Assert.True(other.Held);
            other.Handle!.Dispose();
            probe.Send("release");
            Assert.Equal("RELEASED", probe.ReadLine());
        }

        var mine = MachineNamedLock.Acquire(LockScope.Destination, key);
        Assert.True(mine.Held);
        try
        {
            var (second, secondLine) = LockProbeProcess.Run("m", "dst", key);
            using (second) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.DestinationLocked, secondLine);
        }
        finally
        {
            mine.Handle!.Dispose();
        }
    }

    [Fact]
    public void A_machine_lock_created_by_another_Windows_user_is_held_not_bypassed()
    {
        // The probe creates the named event with an EMPTY access list: this
        // user cannot open it at all - exactly how another user's event looks.
        var key = NewKey();
        var (probe, line) = LockProbeProcess.Run("m-denied", "op", key);
        using (probe)
        {
            Assert.Equal("HELD", line);
            Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, MachineNamedLock.Acquire(LockScope.Operation, key).ErrorCode);
            probe.Kill();
        }
        Assert.True(Eventually.True(() =>
        {
            var again = MachineNamedLock.Acquire(LockScope.Operation, key);
            again.Handle?.Dispose();
            return again.Held;
        }));
    }

    [Fact]
    public void The_machine_lock_name_is_global_and_never_contains_the_key()
    {
        var name = MachineNamedLock.NameFor(LockScope.Operation, "http://localhost:3100|secret-looking-key");

        Assert.StartsWith(@"Global\ArchCadConnect.Lock.op.", name, StringComparison.Ordinal);
        Assert.DoesNotContain("secret", name, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("localhost", name, StringComparison.OrdinalIgnoreCase);
        Assert.NotEqual(name, MachineNamedLock.NameFor(LockScope.Destination, "http://localhost:3100|secret-looking-key"));
    }

    // ---- aliases through the whole stack ------------------------------------------------

    [Fact]
    public void A_workspace_locked_through_a_junction_is_locked_for_its_real_path_too()
    {
        var ws = _tree.Workspace(@"real\WS");
        _tree.File(@"real\WS\a.ipt");
        var link = _tree.Junction("link", Path.Combine(_tree.Root, "real"));
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

        var (probe, line) = LockProbeProcess.Run("doc", Path.Combine(link, @"WS\a.ipt"));
        using (probe)
        {
            Assert.Equal("HELD", line);

            var direct = acquirer.TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(ws, "a.ipt")));
            Assert.False(direct.Acquired);
            Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, direct.Refusal!.ErrorCode);
            Assert.Equal(probe.Id, direct.Refusal.HolderProcessId);

            var upper = acquirer.TryAcquire(WorkspaceLockRequest.ForGetLatest("Get Latest", ws.ToUpperInvariant() + @"\"));
            Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, upper.Refusal!.ErrorCode);
        }
    }

    [Fact]
    public void A_destination_folder_reached_through_a_junction_is_the_same_machine_lock()
    {
        _tree.Dir(@"real\Out");
        var source = _tree.File(@"src\a.ipt");
        var link = _tree.Junction("link", Path.Combine(_tree.Root, "real"));
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

        var first = acquirer.TryAcquire(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", "http://localhost:3100", NewKey(),
            new[] { source }, new[] { Path.Combine(link, @"Out\a2.ipt") }));
        Assert.True(first.Acquired, first.Refusal?.ErrorCode);
        try
        {
            var second = acquirer.TryAcquire(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", "http://localhost:3100", NewKey(),
                new[] { source }, new[] { Path.Combine(_tree.Root, @"real\Out\b2.ipt") }));
            Assert.Equal(WorkspaceLockErrorCodes.DestinationLocked, second.Refusal!.ErrorCode);
        }
        finally
        {
            first.Lease!.Dispose();
        }
    }

    [Fact]
    public void The_same_Copy_Design_operation_cannot_run_twice_on_this_machine()
    {
        var source = _tree.File(@"src\a.ipt");
        _tree.Dir("OutA");
        _tree.Dir("OutB");
        var key = NewKey();
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

        var first = acquirer.TryAcquire(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", "http://localhost:3100", key,
            new[] { source }, new[] { Path.Combine(_tree.Root, @"OutA\a2.ipt") }));
        Assert.True(first.Acquired);
        try
        {
            // A Resume of the same operation into a DIFFERENT folder.
            var resume = acquirer.TryAcquire(WorkspaceLockRequest.ForCopyDesign("Resume Copy Design", "HTTP://LOCALHOST:3100/", key,
                new[] { source }, new[] { Path.Combine(_tree.Root, @"OutB\a2.ipt") }));
            Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, resume.Refusal!.ErrorCode);
            Assert.Equal(key, resume.Refusal.IdempotencyKey);
        }
        finally
        {
            first.Lease!.Dispose();
        }
    }

    // ---- lifetime -------------------------------------------------------------------------

    [Fact]
    public void A_lease_reachable_only_from_its_work_closure_stays_held_through_garbage_collection()
    {
        var ws = Workspace();
        var release = AcquireInsideClosure(ws);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        var (probe, line) = LockProbeProcess.Run("w", ws, "exclusive");
        using (probe) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.WorkspaceLocked, line);

        release();
        var (after, afterLine) = LockProbeProcess.Run("w", ws, "exclusive");
        using (after) Assert.Equal("HELD", afterLine);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static Action AcquireInsideClosure(string ws)
    {
        var acquisition = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance)
            .TryAcquire(WorkspaceLockRequest.ForGetLatest("Get Latest", ws));
        Assert.True(acquisition.Acquired, acquisition.Refusal?.ErrorCode);
        var lease = acquisition.Lease!;
        return () => lease.Dispose();
    }
}
