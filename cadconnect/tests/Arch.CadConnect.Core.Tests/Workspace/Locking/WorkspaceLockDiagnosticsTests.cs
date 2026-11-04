using System.Text;
using Arch.CadConnect.Core.Diagnostics;
using Arch.CadConnect.Core.Tests.Diagnostics;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: lock refusals and lock steps in the M4.2 diagnostics log - every
/// field allow-listed (nothing dropped), and the holder's machine name and
/// record text never written.
/// </summary>
public sealed class WorkspaceLockDiagnosticsTests : IDisposable
{
    private static readonly FixedTime Time = new(new DateTimeOffset(2026, 10, 29, 9, 0, 0, TimeSpan.Zero));
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "arch-m44-log-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private static WorkspaceLockRefusal LockedByGetLatest() => new(
        WorkspaceLockErrorCodes.WorkspaceLocked, LockScope.Workspace, LockMode.Exclusive, @"D:\ws",
        Holder: WorkspaceLockHolderRecord.ForCurrentProcess("Get Latest", LockMode.Exclusive) with { MachineName = "SECRET-HOSTNAME-42" },
        HolderProcessId: 4242);

    [Fact]
    public void A_lock_refusal_is_one_refused_event_with_codes_path_and_holder_process_id()
    {
        var sink = new RecordingSink();

        WorkspaceLockDiagnostics.Refusal(sink, "Checkout", LockedByGetLatest(), Time);

        var e = Assert.Single(sink.Events);
        Assert.Equal(DiagnosticOutcome.Refused, e.Outcome);
        Assert.Equal(WorkspaceLockDiagnostics.RefusalOperation, e.Operation);
        Assert.Equal("Checkout", sink.Field(e, "command"));
        Assert.Equal("workspace-locked", sink.Field(e, "errorCode"));
        Assert.Equal("workspace", sink.Field(e, "lockScope"));
        Assert.Equal("exclusive", sink.Field(e, "lockMode"));
        Assert.Equal(@"D:\ws", sink.Field(e, "path"));
        Assert.Equal(4242L, sink.Field(e, "holderProcessId"));
        Assert.All(e.Fields, f => Assert.True(DiagnosticFieldAllowList.IsAllowed(f), f.Name));
    }

    [Fact]
    public void A_path_class_refusal_records_its_locality()
    {
        var sink = new RecordingSink();

        WorkspaceLockDiagnostics.Refusal(sink, "Get Latest",
            new WorkspaceLockRefusal(WorkspaceLockErrorCodes.PathNetworkUnsupported, Path: @"\\srv\share\ws", Locality: PathLocality.Network), Time);

        var e = Assert.Single(sink.Events);
        Assert.Equal("path-network-unsupported", sink.Field(e, "errorCode"));
        Assert.Equal("network", sink.Field(e, "pathLocality"));
    }

    [Fact]
    public void Written_to_the_real_log_nothing_is_dropped_and_the_machine_name_never_appears()
    {
        using (var sink = new JsonLinesDiagnosticsSink(_dir, userProfile: @"C:\Users\Someone"))
        {
            WorkspaceLockDiagnostics.Refusal(sink, "Checkout", LockedByGetLatest(), Time);
            WorkspaceLockDiagnostics.Refusal(sink, "Resume Copy Design",
                new WorkspaceLockRefusal(WorkspaceLockErrorCodes.OperationLocked, LockScope.Operation, LockMode.Exclusive, IdempotencyKey: "key-123"), Time);
        }

        var text = string.Join("\n", Directory.GetFiles(_dir).Select(f => File.ReadAllText(f, Encoding.UTF8)));
        Assert.Contains("\"errorCode\":\"workspace-locked\"", text);
        Assert.Contains("\"idempotencyKey\":\"key-123\"", text);
        Assert.DoesNotContain("droppedFields", text);
        Assert.DoesNotContain("SECRET-HOSTNAME-42", text);
        Assert.DoesNotContain(Environment.MachineName, text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Get Latest", text); // the holder's command text is not logged either
    }

    [Fact]
    public void Acquired_and_released_steps_count_the_locks_and_time_the_hold()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var lease = new WorkspaceLockAcquirer(fs, new FakeLockHandleFactory(), Time)
            .TryAcquire(WorkspaceLockRequest.ForDocument("Checkout", @"D:\WS\a.ipt")).Lease!;
        var sink = new RecordingSink();
        var attempt = DiagnosticsAttempt.Start(sink, "pdm.checkout", Time);

        WorkspaceLockDiagnostics.Acquired(attempt, lease, durationMs: 3);
        lease.Dispose();
        WorkspaceLockDiagnostics.Released(attempt, lease, Time.Now.AddMilliseconds(1500));

        var acquired = sink.Events.Single(e => (string?)sink.Field(e, "step") == WorkspaceLockDiagnostics.AcquiredStep);
        Assert.Equal(1L, sink.Field(acquired, "lockCount"));
        Assert.Equal(3L, sink.Field(acquired, "durationMs"));
        var released = sink.Events.Single(e => (string?)sink.Field(e, "step") == WorkspaceLockDiagnostics.ReleasedStep);
        Assert.Equal(1500L, sink.Field(released, "durationMs"));
        Assert.Equal(0L, sink.Field(released, "failed"));
        Assert.All(sink.Events.SelectMany(e => e.Fields), f => Assert.True(DiagnosticFieldAllowList.IsAllowed(f), f.Name));
    }
}
