using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R10 NO-GO correction (MAJOR 4): stopping, admitting
///  and completing are one gated decision, so an answer that arrives after the
///  stop never authorizes anything, and every admitted worker is joined with its
///  permit returned once. Test IDs follow the approved correction plan.</summary>
public class CheckoutStatusReconcilerR10FixTests
{
    private static readonly ServerCheckoutStatus Available = new(ServerCheckoutState.Available);
    private static readonly TimeSpan Long = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan Bound = TimeSpan.FromSeconds(20);

    private static string[] Ids(int count) => Enumerable.Range(0, count).Select(i => "cad_" + i).ToArray();

    private static Task<IReadOnlyDictionary<string, CheckoutStatusOutcome>> Run(
        int count,
        Func<string, CancellationToken, Task<ServerCheckoutStatus>> query,
        TimeSpan deadline,
        CheckoutStatusReconcilerHooks hooks,
        CancellationToken ct = default) =>
        CheckoutStatusReconciler.RunAsync(Ids(count), query, deadline, ct, hooks);

    [Fact]
    public async Task R1_an_answer_that_ignores_cancellation_and_arrives_after_the_deadline_is_not_an_answer()
    {
        var latched = new TaskCompletionSource();
        var permits = -1;

        var outcomes = await Run(1, async (_, _) =>
        {
            await latched.Task.WaitAsync(Bound);
            return Available;
        }, TimeSpan.FromMilliseconds(50), new(OnStopLatched: latched.SetResult, OnClosed: p => permits = p));

        Assert.True(outcomes["cad_0"].NotAsked);
        Assert.Null(outcomes["cad_0"].Status);
        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, permits);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task R2_R3_after_the_third_failure_a_late_answer_or_failure_counts_for_nothing(bool lateFails)
    {
        var latched = new TaskCompletionSource();
        var failedFirst = 0;

        var outcomes = await Run(4, async (id, _) =>
        {
            if (id != "cad_3")
            {
                Interlocked.Increment(ref failedFirst);
                throw new HttpRequestException("down");
            }
            await latched.Task.WaitAsync(Bound);
            return lateFails ? throw new HttpRequestException("late") : Available;
        }, Long, new(OnStopLatched: latched.SetResult));

        Assert.Equal(3, failedFirst);
        Assert.All(new[] { "cad_0", "cad_1", "cad_2" }, id => Assert.False(outcomes[id].NotAsked));
        Assert.True(outcomes["cad_3"].NotAsked);
        Assert.Null(outcomes["cad_3"].Status);
    }

    [Fact]
    public async Task R4_a_stop_between_two_schedulings_admits_nothing_more()
    {
        using var cancel = new CancellationTokenSource();
        var asked = new System.Collections.Concurrent.ConcurrentBag<string>();
        using var bothAsked = new CountdownEvent(2);

        await Run(10, (id, _) =>
        {
            asked.Add(id);
            bothAsked.Signal();
            return Task.FromResult(Available);
        }, Long, new(BeforeWait: i =>
        {
            if (i == 2)
            {
                Assert.True(bothAsked.Wait(Bound));
                cancel.Cancel();
            }
        }), cancel.Token);

        Assert.Equal(new[] { "cad_0", "cad_1" }, asked.OrderBy(x => x, StringComparer.Ordinal));
    }

    [Fact]
    public async Task R5_with_the_deadline_and_the_caller_stopping_together_nothing_is_answered_and_the_caller_sees_its_cancellation()
    {
        using var cancel = new CancellationTokenSource();
        var asked = 0;

        var outcomes = await Run(6, (_, _) =>
        {
            Interlocked.Increment(ref asked);
            return Task.FromResult(Available);
        }, TimeSpan.FromMilliseconds(1), new(BeforeWait: i =>
        {
            if (i == 0)
            {
                Thread.Sleep(20); // the deadline has fired
                cancel.Cancel();
            }
        }), cancel.Token);

        Assert.Equal(0, asked);
        Assert.All(outcomes.Values, o => Assert.True(o.NotAsked));
        // The orchestrator checks this after the run: the caller's own stop wins.
        Assert.True(cancel.IsCancellationRequested);
    }

    [Fact]
    public async Task R6_the_breaker_and_cancellation_callbacks_never_deadlock_against_the_gate()
    {
        var latches = 0;

        var outcomes = await Run(200, async (_, token) =>
        {
            // Every request's own cancellation callback runs while the breaker fires.
            using var registration = token.Register(() => Thread.Sleep(1));
            await Task.Yield();
            throw new HttpRequestException("down");
        }, Long, new(OnStopLatched: () => Interlocked.Increment(ref latches))).WaitAsync(Bound);

        Assert.Equal(1, latches);
        Assert.Equal(CheckoutStatusReconciler.BreakerFailures, outcomes.Values.Count(o => !o.NotAsked));
    }

    [Fact]
    public async Task R7_every_admitted_worker_has_ended_before_the_run_returns()
    {
        var started = 0;
        var ended = 0;

        await Run(12, async (_, _) =>
        {
            Interlocked.Increment(ref started);
            try
            {
                await Task.Delay(1000); // ignores cancellation (CI: scaled 100 -> 1000 ms with the deadline)
                return Available;
            }
            finally
            {
                Interlocked.Increment(ref ended);
            }
        }, TimeSpan.FromMilliseconds(300), new()); // CI: scaled 30 -> 300 ms, still shorter than each query

        Assert.Equal(started, Volatile.Read(ref ended));
        Assert.InRange(started, 1, 12);
    }

    [Fact]
    public async Task R9_under_random_timing_no_answer_completed_after_the_stop_is_ever_recorded()
    {
        for (var iteration = 0; iteration < 50; iteration++)
        {
            var random = new Random(iteration);
            var latched = 0;
            var lateIds = new System.Collections.Concurrent.ConcurrentBag<string>();
            var delays = Enumerable.Range(0, 200).Select(_ => random.Next(0, 4)).ToArray();

            var outcomes = await Run(200, async (id, _) =>
            {
                await Task.Delay(delays[int.Parse(id[4..])]); // ignores cancellation
                if (Volatile.Read(ref latched) == 1)
                {
                    lateIds.Add(id);
                }
                return Available;
            }, TimeSpan.FromMilliseconds(5 + random.Next(0, 25)), new(OnStopLatched: () => Volatile.Write(ref latched, 1)));

            Assert.All(lateIds, id => Assert.True(outcomes[id].NotAsked, $"iteration {iteration}: {id} answered after the stop was recorded"));
            Assert.All(outcomes.Values, o => Assert.True(o.NotAsked || o.Status is not null));
        }
    }

    [Fact]
    public async Task Q1_a_blocking_synchronous_query_prefix_cannot_hold_back_the_stop()
    {
        using var blocker = new ManualResetEventSlim();
        var latched = new TaskCompletionSource();
        var asked = 0;
        var permits = -1;

        var run = Run(8, (_, _) =>
        {
            Interlocked.Increment(ref asked);
            blocker.Wait(Bound); // synchronous, ignores cancellation
            return Task.FromResult(Available);
        }, TimeSpan.FromSeconds(1), new( // CI: generous; workers block until released after the stop
            OnStopLatched: latched.SetResult, OnClosed: p => permits = p));

        // The stop latches while every worker is still blocked inside its query.
        await latched.Task.WaitAsync(Bound);
        Assert.False(run.IsCompleted);
        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, Volatile.Read(ref asked));

        blocker.Set();
        var outcomes = await run.WaitAsync(Bound);

        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, asked);
        Assert.All(outcomes.Values, o => Assert.True(o.NotAsked));
        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, permits);
    }

    [Fact]
    public async Task Q2_a_stop_between_admission_and_invocation_never_sends_the_query()
    {
        using var cancel = new CancellationTokenSource();
        var asked = 0;
        var permits = -1;

        var outcomes = await Run(1, (_, _) =>
        {
            Interlocked.Increment(ref asked);
            return Task.FromResult(Available);
        }, Long, new(AfterAdmission: _ => cancel.Cancel(), OnClosed: p => permits = p), cancel.Token);

        Assert.Equal(0, asked);
        Assert.True(outcomes["cad_0"].NotAsked);
        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, permits);
    }

    [Fact]
    public async Task Q3_a_worker_that_fails_to_start_returns_its_permit_once_and_the_others_still_finish()
    {
        var ended = new System.Collections.Concurrent.ConcurrentBag<string>();
        using var firstEntered = new ManualResetEventSlim();
        var permits = -1;

        var outcomes = await Run(6, async (id, _) =>
        {
            firstEntered.Set();
            await Task.Delay(20);
            ended.Add(id);
            return Available;
        }, Long, new(StartWorker: i =>
        {
            if (i == 1)
            {
                Assert.True(firstEntered.Wait(Bound));
                throw new InvalidOperationException("planted start failure");
            }
        }, OnClosed: p => permits = p));

        Assert.Equal(new[] { "cad_0" }, ended);
        Assert.All(Ids(6).Skip(1), id => Assert.True(outcomes[id].NotAsked));
        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, permits);
    }

    [Fact]
    public async Task Q4_when_scheduling_throws_every_started_worker_is_joined_first()
    {
        var release = new TaskCompletionSource();
        var ended = 0;

        var run = Run(6, async (_, _) =>
        {
            await release.Task.WaitAsync(Bound); // ignores cancellation
            Interlocked.Increment(ref ended);
            return Available;
        }, Long, new(BeforeWait: i =>
        {
            if (i == 2) throw new InvalidDataException("planted scheduling failure");
        }));

        await Task.Delay(200);
        Assert.False(run.IsCompleted);
        release.SetResult();

        await Assert.ThrowsAsync<InvalidDataException>(() => run.WaitAsync(Bound));
        Assert.Equal(2, ended);
    }

    [Fact]
    public async Task Q5_every_permit_is_back_after_a_normal_run_a_breaker_and_a_deadline()
    {
        foreach (var (query, deadline) in new (Func<string, CancellationToken, Task<ServerCheckoutStatus>>, TimeSpan)[]
        {
            ((_, _) => Task.FromResult(Available), Long),
            ((_, _) => Task.FromException<ServerCheckoutStatus>(new HttpRequestException("down")), Long),
            (async (_, token) => { await Task.Delay(Timeout.Infinite, token); return Available; }, TimeSpan.FromMilliseconds(20)),
        })
        {
            var permits = -1;
            await Run(20, query, deadline, new(OnClosed: p => permits = p));
            Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, permits);
        }
    }
}
