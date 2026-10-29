using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 M4.1a: how the orchestrator reports the three shapes a SESSION-BOUND
/// refusal takes (the connection changed after the attempt started - see
/// ArchConnectionManager's session-bound overloads, which produce exactly
/// these shapes):
///   - reservation: a NON-transient exception (never retried);
///   - operation status: an <see cref="CopyDesignOperationStatusOutcome.AuthenticationFailed"/> result;
///   - materialization: a <see cref="CopyDesignMaterializationOutcome.Failed"/> result.
/// In every case the attempt must stop sending, keep its idempotency key and
/// (once reserved) its operation id for Resume / Recover, and delete nothing
/// it cannot prove it created in a failed earlier phase.
/// </summary>
public class CopyDesignSessionSwitchOrchestratorTests
{
    private const string SessionChanged = "The Arch PLM connection changed while Copy Design was running";

    private static (CopyDesignPlan Plan, OrchestratorHarness Harness) Single()
    {
        var h = new OrchestratorHarness { IsTransientReservationFailure = ex => ex is IOException };
        var node = CopyNode("cad-1", @"C:\src\a.ipt", @"C:\dst\a-new.ipt");
        h.ExistingSources.Add(node.SourceAbsolutePath);
        return (Plan(new[] { node }), h);
    }

    [Fact]
    public async Task A_switch_before_reservation_stops_without_retry_and_keeps_the_idempotency_key_for_Recover()
    {
        var (plan, h) = Single();
        h.Reservation.ThrowOnCall = new InvalidOperationException(SessionChanged);

        var result = await h.Build().ExecuteAsync(plan, "key-m41a", null);

        Assert.Equal(CopyDesignApplyOutcome.ReservationCallFailed, result.Outcome);
        Assert.Equal("key-m41a", result.IdempotencyKey);
        Assert.Contains("key-m41a", result.FailureReason);
        Assert.Null(result.CopyDesignOperationId);
        Assert.Single(h.Reservation.Calls);
        Assert.Empty(h.Copier.Calls);
        Assert.Empty(h.Materializer.Calls);
        Assert.Empty(h.Deleted);
    }

    [Fact]
    public async Task A_switch_during_the_reservation_retry_backoff_stops_retrying_and_keeps_the_SAME_key()
    {
        // The first attempt failed transiently (and may have committed), then
        // the connection changed before the bounded retry.
        var (plan, h) = Single();
        h.Reservation.ThrowForCall = call => call == 1
            ? new IOException("simulated transient failure")
            : new InvalidOperationException(SessionChanged);

        var result = await h.Build().ExecuteAsync(plan, "key-m41a", null);

        Assert.Equal(CopyDesignApplyOutcome.ReservationCallFailed, result.Outcome);
        Assert.Equal("key-m41a", result.IdempotencyKey);
        Assert.Equal(2, h.Reservation.Calls.Count);  // no third attempt after the refusal
        Assert.All(h.Reservation.Calls, r => Assert.Equal("key-m41a", r.IdempotencyKey));
        Assert.Empty(h.Copier.Calls);
    }

    [Fact]
    public async Task A_switch_before_the_status_check_stops_before_physical_work_and_keeps_the_operation_id()
    {
        var (plan, h) = Single();
        h.IncludeOperationStatusClient = true;
        h.OperationStatusClient.ForcedResult = () =>
            CopyDesignOperationStatusResult.Failure(CopyDesignOperationStatusOutcome.AuthenticationFailed);

        var result = await h.Build().ExecuteAsync(plan, "key-m41a", null);

        Assert.Equal(CopyDesignApplyOutcome.UnexpectedMaterializationState, result.Outcome);
        Assert.Equal("op-1", result.CopyDesignOperationId);
        Assert.Equal("key-m41a", result.IdempotencyKey);
        Assert.True(result.ReservedButUnmaterialized);  // -> remembered for Resume
        Assert.Empty(h.Copier.Calls);
        Assert.Empty(h.Materializer.Calls);
        Assert.Empty(h.Deleted);
    }

    [Fact]
    public async Task A_switch_before_upload_leaves_the_verified_destination_in_place_and_keeps_the_operation_id()
    {
        var (plan, h) = Single();
        h.Materializer.Responder = id => new CopyDesignMaterializationResult(
            id, CopyDesignMaterializationOutcome.Failed, null, null, null, null, SessionChanged);

        var result = await h.Build().ExecuteAsync(plan, "key-m41a", null);

        Assert.Equal(CopyDesignApplyOutcome.SucceededWithMaterializationGaps, result.Outcome);
        Assert.Equal("op-1", result.CopyDesignOperationId);
        Assert.Equal("key-m41a", result.IdempotencyKey);
        Assert.True(result.ReservedButUnmaterialized);
        // Never an automatic delete of the destination (the reservation is
        // real and Resume will materialize it) - nor of any backup this
        // attempt did not prove it created.
        Assert.Empty(h.Deleted);
        var entry = Assert.Single(result.Entries);
        Assert.True(entry.PhysicallyCreated);
        Assert.Equal(SessionChanged, entry.Materialization!.Detail);
    }
}
