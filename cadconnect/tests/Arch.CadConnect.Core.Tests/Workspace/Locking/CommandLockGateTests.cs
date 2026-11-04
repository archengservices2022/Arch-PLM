using System.Runtime.Versioning;
using Arch.CadConnect.Core.Diagnostics;
using Arch.CadConnect.Core.Tests.Diagnostics;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4 Phase 2: the gate every mutating command goes through, run the way
/// the controller runs it - origin check first (an origin refusal touches no
/// lock and creates no artifact), the complete lease, the origin check again
/// while locked, then the work queued with the locks held through every
/// await and released exactly once however it ends. A refused command never
/// reaches its "server".
/// </summary>
public class CommandLockGateTests
{
    private static readonly FixedTime Time = new(new DateTimeOffset(2026, 10, 29, 10, 0, 0, TimeSpan.Zero));

    /// <summary>What the controller does with an admission: run the work
    ///  (here: one "server request") through <see cref="CommandLock.Queue"/>
    ///  on a background task. Returns null when the command was refused.</summary>
    private static Task? RunLikeTheController(
        CommandLockGate gate, WorkspaceLockRequest request, Func<bool> origin, Func<CancellationToken, Task> serverWork,
        DiagnosticsAttempt? attempt = null)
    {
        if (gate.Admit(request, origin).Lock is not { } held) return null;
        using var releaseIfNotQueued = held.ReleaseUnlessQueued();
        held.AttachDiagnostics(attempt);
        Task? running = null;
        held.Queue(locked => running = Task.Run(() => locked(CancellationToken.None)), serverWork);
        return running;
    }

    private static (CommandLockGate Gate, FakeLockHandleFactory Factory, FakeLockPathSystem Fs, RecordingSink Sink) FakeGate()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var factory = new FakeLockHandleFactory();
        var sink = new RecordingSink();
        return (new CommandLockGate(new WorkspaceLockAcquirer(fs, factory, Time), sink, Time), factory, fs, sink);
    }

    private static WorkspaceLockRequest Checkout() => WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt");

    // ---- order: origin first ---------------------------------------------------------------

    [Fact]
    public void An_origin_refusal_takes_no_lock_and_never_reaches_the_server()
    {
        var (gate, factory, _, sink) = FakeGate();
        var originChecks = 0;
        var serverRequests = 0;

        var running = RunLikeTheController(gate, Checkout(), () => { originChecks++; return false; },
            _ => { serverRequests++; return Task.CompletedTask; });

        Assert.Null(running);
        Assert.Equal(1, originChecks);
        Assert.Empty(factory.Calls);
        Assert.Equal(0, serverRequests);
        Assert.Empty(sink.Events); // the origin check reports its own refusal
    }

    [Fact]
    [SupportedOSPlatform("windows")]
    public void An_origin_refusal_creates_no_lock_artifact_on_disk()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS");
        tree.File(@"WS\a.ipt");
        var newTarget = Path.Combine(tree.Root, "NewWS");
        var before = tree.Snapshot();
        var gate = new CommandLockGate(new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), null);

        Assert.True(gate.Admit(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(ws, "a.ipt")), () => false).OriginRefused);
        Assert.True(gate.Admit(WorkspaceLockRequest.ForGetLatest("Get Latest", newTarget), () => false).OriginRefused);
        Assert.True(gate.Admit(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", "http://localhost:3100", "k",
            new[] { Path.Combine(ws, "a.ipt") }, new[] { Path.Combine(tree.Root, @"Out\a2.ipt") }), () => false).OriginRefused);

        Assert.Equal(before, tree.Snapshot());
        Assert.False(Directory.Exists(Path.Combine(ws, ".arch", "locks")));
        Assert.False(Directory.Exists(newTarget));
    }

    [Fact]
    public void The_origin_is_checked_again_while_locked_and_a_late_refusal_releases_everything()
    {
        var (gate, factory, _, _) = FakeGate();
        var calls = 0;
        var serverRequests = 0;

        var running = RunLikeTheController(gate, Checkout(), () => ++calls == 1, _ => { serverRequests++; return Task.CompletedTask; });

        Assert.Null(running);
        Assert.Equal(2, calls);
        Assert.Single(factory.Calls);
        Assert.Equal(factory.Calls, factory.Released);
        Assert.Equal(0, serverRequests);
    }

    [Fact]
    public void An_origin_check_that_throws_while_locked_releases_and_propagates()
    {
        var (gate, factory, _, _) = FakeGate();
        var calls = 0;

        Assert.Throws<IOException>(() => gate.Admit(Checkout(), () => ++calls == 1 ? true : throw new IOException("planted")));
        Assert.Equal(factory.Calls, factory.Released);
    }

    // ---- lock refusals ------------------------------------------------------------------------

    [Fact]
    public void A_lock_refusal_is_logged_with_its_codes_and_never_reaches_the_server()
    {
        var (gate, factory, _, sink) = FakeGate();
        factory.RefuseKeys[@"D:\WS"] = WorkspaceLockErrorCodes.WorkspaceLocked;
        var serverRequests = 0;

        var admission = gate.Admit(Checkout(), () => true);
        var running = RunLikeTheController(gate, Checkout(), () => true, _ => { serverRequests++; return Task.CompletedTask; });

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, admission.LockRefusal!.ErrorCode);
        Assert.False(admission.OriginRefused);
        Assert.Null(running);
        Assert.Equal(0, serverRequests);
        var refusal = sink.Events.First();
        Assert.Equal(WorkspaceLockDiagnostics.RefusalOperation, refusal.Operation);
        Assert.Equal(DiagnosticOutcome.Refused, refusal.Outcome);
        Assert.Equal("Checkout", sink.Field(refusal, "command"));
        Assert.Equal("workspace-locked", sink.Field(refusal, "errorCode"));
        Assert.Equal("workspace", sink.Field(refusal, "lockScope"));
        Assert.Equal("exclusive", sink.Field(refusal, "lockMode"));
    }

    [Fact]
    public void A_path_class_refusal_is_logged_with_its_locality_and_takes_no_lock()
    {
        var fs = new FakeLockPathSystem().Workspace(@"N:\WS").File(@"N:\WS\a.ipt");
        fs.Localities[@"N:\"] = PathLocality.Network;
        var factory = new FakeLockHandleFactory();
        var sink = new RecordingSink();
        var gate = new CommandLockGate(new WorkspaceLockAcquirer(fs, factory, Time), sink, Time);

        var admission = gate.Admit(WorkspaceLockRequest.ForDocument("Check In", @"N:\WS\a.ipt"), () => true);

        Assert.Equal(WorkspaceLockErrorCodes.PathNetworkUnsupported, admission.LockRefusal!.ErrorCode);
        Assert.Empty(factory.Calls);
        Assert.Equal("network", sink.Field(sink.Events.Single(), "pathLocality"));
    }

    [Fact]
    public void An_unexpected_failure_while_locking_fails_closed_as_a_refusal_with_nothing_held()
    {
        var (gate, factory, _, sink) = FakeGate();
        factory.ThrowOnAcquireKey = @"D:\WS";
        var serverRequests = 0;

        var admission = gate.Admit(Checkout(), () => true);
        var running = RunLikeTheController(gate, Checkout(), () => true, _ => { serverRequests++; return Task.CompletedTask; });

        Assert.Equal(WorkspaceLockErrorCodes.LockUnavailable, admission.LockRefusal!.ErrorCode);
        Assert.Null(running);
        Assert.Equal(0, serverRequests);
        Assert.Empty(factory.Released); // the one lock threw - nothing was ever held
        Assert.Equal("lock-unavailable", sink.Field(sink.Events.First(), "errorCode"));
    }

    [Fact]
    public void A_workspace_changed_between_validation_and_acquisition_is_refused_and_released()
    {
        var (gate, factory, fs, sink) = FakeGate();
        factory.OnAcquired = () => fs.Workspace(@"D:\WS", "http://localhost:3000");

        var admission = gate.Admit(Checkout(), () => true);

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceChanged, admission.LockRefusal!.ErrorCode);
        Assert.Equal(factory.Calls, factory.Released);
        Assert.Equal("workspace-changed", sink.Field(sink.Events.Single(), "errorCode"));
    }

    // ---- exactly-once release on every path ----------------------------------------------------

    [Fact]
    public async Task Success_releases_after_the_work_and_logs_acquired_and_released_once()
    {
        var (gate, factory, _, sink) = FakeGate();
        var attempt = DiagnosticsAttempt.Start(sink, "pdm.checkout", Time);
        var releasedDuringWork = -1;

        await RunLikeTheController(gate, Checkout(), () => true, _ =>
        {
            releasedDuringWork = factory.Released.Count;
            return Task.CompletedTask;
        }, attempt)!;

        Assert.Equal(0, releasedDuringWork);
        Assert.Equal(factory.Calls, factory.Released);
        Assert.Single(sink.Events, e => (string?)sink.Field(e, "step") == WorkspaceLockDiagnostics.AcquiredStep);
        Assert.Single(sink.Events, e => (string?)sink.Field(e, "step") == WorkspaceLockDiagnostics.ReleasedStep);
    }

    [Theory]
    [InlineData("exception")]
    [InlineData("cancellation")]
    [InlineData("timeout")]
    public async Task A_failing_cancelled_or_timed_out_command_releases_exactly_once(string ending)
    {
        var (gate, factory, _, sink) = FakeGate();
        var attempt = DiagnosticsAttempt.Start(sink, "pdm.checkout", Time);
        using var timeout = new CancellationTokenSource();

        var running = RunLikeTheController(gate, Checkout(), () => true, async _ =>
        {
            await Task.Yield();
            switch (ending)
            {
                case "exception": throw new IOException("planted");
                case "cancellation": throw new OperationCanceledException();
                default:
                    timeout.Cancel();
                    timeout.Token.ThrowIfCancellationRequested();
                    break;
            }
        }, attempt)!;

        await Assert.ThrowsAnyAsync<Exception>(() => running);
        Assert.Equal(factory.Calls, factory.Released);
        Assert.Single(sink.Events, e => (string?)sink.Field(e, "step") == WorkspaceLockDiagnostics.ReleasedStep);
    }

    [Fact]
    public void A_background_queue_failure_releases_every_lock_and_propagates()
    {
        var (gate, factory, _, _) = FakeGate();
        var held = gate.Admit(Checkout(), () => true).Lock!;
        var serverRequests = 0;

        using (held.ReleaseUnlessQueued())
        {
            Assert.Throws<InvalidOperationException>(() =>
                held.Queue(_ => throw new InvalidOperationException("queue full"), _ => { serverRequests++; return Task.CompletedTask; }));
        }

        Assert.True(held.IsReleased);
        Assert.Equal(factory.Calls, factory.Released); // once, not twice
        Assert.Equal(0, serverRequests);
    }

    [Fact]
    public void An_exception_before_queueing_releases_through_the_start_scope()
    {
        var (gate, factory, _, _) = FakeGate();

        void PrepareAndFail()
        {
            var held = gate.Admit(Checkout(), () => true).Lock!;
            using var releaseIfNotQueued = held.ReleaseUnlessQueued();
            throw new InvalidOperationException("orchestrator construction failed");
        }

        Assert.Throws<InvalidOperationException>(PrepareAndFail);
        Assert.Equal(factory.Calls, factory.Released);
    }

    [Fact]
    public async Task Once_queued_the_start_scope_leaves_the_locks_to_the_work()
    {
        var (gate, factory, _, _) = FakeGate();
        var gateOpen = new TaskCompletionSource();
        var held = gate.Admit(Checkout(), () => true).Lock!;
        Task? running = null;

        using (held.ReleaseUnlessQueued())
        {
            held.Queue(locked => running = Task.Run(() => locked(CancellationToken.None)), _ => gateOpen.Task);
        }

        Assert.False(held.IsReleased);
        Assert.Empty(factory.Released);
        gateOpen.SetResult();
        await running!;
        Assert.True(held.IsReleased);
        Assert.Equal(factory.Calls, factory.Released);
    }

    [Fact]
    public void A_lock_runs_exactly_one_piece_of_work()
    {
        var (gate, _, _, _) = FakeGate();
        var held = gate.Admit(Checkout(), () => true).Lock!;
        held.Queue(_ => { }, _ => Task.CompletedTask);

        Assert.Throws<InvalidOperationException>(() => held.Queue(_ => { }, _ => Task.CompletedTask));
        held.Release();
    }

    [Fact]
    public void Releasing_twice_and_from_many_threads_releases_each_handle_once()
    {
        var (gate, factory, _, _) = FakeGate();
        var held = gate.Admit(Checkout(), () => true).Lock!;

        Parallel.For(0, 16, _ => held.Release());
        held.Dispose();

        Assert.Equal(factory.Calls, factory.Released);
    }

    // ---- real locks: held through every await, conflicting commands refused ------------------------

    [Fact]
    [SupportedOSPlatform("windows")]
    public async Task The_locks_stay_held_through_every_await_of_the_work_and_conflicting_commands_are_refused()
    {
        using var tree = new TempTree();
        var ws = tree.Workspace("WS");
        var file = tree.File(@"WS\a.ipt");
        var gate = new CommandLockGate(new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), null);
        var midWork = new TaskCompletionSource();
        var finishWork = new TaskCompletionSource();

        var running = RunLikeTheController(gate, WorkspaceLockRequest.ForGetLatest("Get Latest", ws), () => true, async _ =>
        {
            await Task.Delay(10);         // a "server request"
            midWork.SetResult();
            await finishWork.Task;        // "downloads"
            await Task.Delay(10);         // the "manifest write"
        })!;
        await midWork.Task;

        // Another process and this process are both refused while the work awaits.
        var canonical = WindowsLockPathSystem.Instance.Resolve(ws).Canonical;
        var (probe, line) = LockProbeProcess.Run("w", canonical, "exclusive");
        using (probe) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.WorkspaceLocked, line);
        foreach (var command in new[] { "Checkout", "Check In", "Undo Checkout" })
        {
            Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked,
                gate.Admit(WorkspaceLockRequest.ForDocument(command, file), () => true).LockRefusal!.ErrorCode);
        }
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked,
            gate.Admit(WorkspaceLockRequest.ForGetLatest("Get Latest", ws), () => true).LockRefusal!.ErrorCode);

        finishWork.SetResult();
        await running;

        var after = gate.Admit(WorkspaceLockRequest.ForDocument("Checkout", file), () => true);
        Assert.NotNull(after.Lock);
        after.Lock!.Release();
    }

    [Fact]
    [SupportedOSPlatform("windows")]
    public void Copy_Design_shares_its_source_but_excludes_writers_the_same_operation_and_its_destination()
    {
        using var tree = new TempTree();
        var src = tree.Workspace("Src");
        var part = tree.File(@"Src\a.ipt");
        tree.Dir("OutA");
        tree.Dir("OutB");
        var gate = new CommandLockGate(new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), null);
        var key = "m44-gate-" + Guid.NewGuid().ToString("N");
        WorkspaceLockRequest Copy(string command, string k, string destination) => WorkspaceLockRequest.ForCopyDesign(
            command, "http://localhost:3100", k, new[] { part }, new[] { Path.Combine(tree.Root, destination) });

        var apply = gate.Admit(Copy("Apply Copy Design", key, @"OutA\a2.ipt"), () => true).Lock!;
        try
        {
            // the source workspace is read-shared: no writer may change it
            Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked,
                gate.Admit(WorkspaceLockRequest.ForGetLatest("Get Latest", src), () => true).LockRefusal!.ErrorCode);
            Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked,
                gate.Admit(WorkspaceLockRequest.ForDocument("Checkout", part), () => true).LockRefusal!.ErrorCode);
            // the same operation cannot run twice - not even resumed into another folder
            var resume = gate.Admit(Copy("Resume Copy Design", key, @"OutB\a2.ipt"), () => true);
            Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, resume.LockRefusal!.ErrorCode);
            var recover = gate.Admit(Copy("Recover Copy Design", key, @"OutA\a2.ipt"), () => true);
            Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, recover.LockRefusal!.ErrorCode);
            // another operation into the same destination folder is refused
            Assert.Equal(WorkspaceLockErrorCodes.DestinationLocked,
                gate.Admit(Copy("Apply Copy Design", key + "-2", @"OutA\b2.ipt"), () => true).LockRefusal!.ErrorCode);
            // another operation reading the same source into another folder may run
            var reader = gate.Admit(Copy("Apply Copy Design", key + "-3", @"OutB\c2.ipt"), () => true);
            Assert.NotNull(reader.Lock);
            reader.Lock!.Release();
        }
        finally
        {
            apply.Release();
        }

        var getLatest = gate.Admit(WorkspaceLockRequest.ForGetLatest("Get Latest", src), () => true);
        Assert.NotNull(getLatest.Lock);
        getLatest.Lock!.Release();
    }
}
