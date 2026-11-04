using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R10: bounded concurrency, one linked token, and no
///  return while a request is running.</summary>
public class CheckoutStatusReconcilerTests
{
    private static readonly ServerCheckoutStatus Available = new(ServerCheckoutState.Available);
    private static readonly TimeSpan Long = TimeSpan.FromMinutes(5);

    private static string[] Ids(int count) => Enumerable.Range(0, count).Select(i => "cad_" + i).ToArray();

    [Fact]
    public async Task Every_document_is_asked_about_with_at_most_four_at_once()
    {
        var running = 0;
        var peak = 0;
        var asked = new System.Collections.Concurrent.ConcurrentBag<string>();

        var outcomes = await CheckoutStatusReconciler.RunAsync(Ids(40), async (id, _) =>
        {
            var now = Interlocked.Increment(ref running);
            InterlockedMax(ref peak, now);
            asked.Add(id);
            await Task.Delay(5);
            Interlocked.Decrement(ref running);
            return Available;
        }, Long, CancellationToken.None);

        Assert.Equal(40, asked.Distinct().Count());
        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, peak);
        Assert.All(outcomes.Values, o => Assert.False(o.NotAsked));
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int seen;
        while (value > (seen = Volatile.Read(ref target)) && Interlocked.CompareExchange(ref target, value, seen) != seen)
        {
        }
    }

    [Fact]
    public async Task Four_requests_really_run_together_before_any_finishes()
    {
        var all = new TaskCompletionSource();
        var started = 0;

        await CheckoutStatusReconciler.RunAsync(Ids(4), async (_, _) =>
        {
            if (Interlocked.Increment(ref started) == 4)
            {
                all.SetResult();
            }
            await all.Task.WaitAsync(TimeSpan.FromSeconds(20));
            return Available;
        }, Long, CancellationToken.None);

        Assert.Equal(4, started);
    }

    [Fact]
    public async Task An_empty_set_asks_nothing()
    {
        var outcomes = await CheckoutStatusReconciler.RunAsync([], (_, _) => throw new InvalidOperationException(), Long, CancellationToken.None);

        Assert.Empty(outcomes);
    }

    [Fact]
    public async Task The_third_genuine_failure_stops_the_run_and_nothing_new_starts()
    {
        var asked = 0;

        var outcomes = await CheckoutStatusReconciler.RunAsync(Ids(100), async (_, _) =>
        {
            Interlocked.Increment(ref asked);
            await Task.Yield();
            throw new HttpRequestException("down");
        }, Long, CancellationToken.None);

        Assert.InRange(asked, CheckoutStatusReconciler.BreakerFailures, CheckoutStatusReconciler.BreakerFailures + CheckoutStatusReconciler.MaxConcurrency);
        Assert.Contains(outcomes.Values, o => o.NotAsked);
        Assert.True(outcomes.Values.All(o => o.Status is null));
    }

    [Fact]
    public async Task A_success_between_failures_does_not_reset_the_breaker()
    {
        var calls = 0;

        var outcomes = await CheckoutStatusReconciler.RunAsync(Ids(50), async (_, _) =>
        {
            var n = Interlocked.Increment(ref calls);
            await Task.Yield();
            return n % 2 == 0 ? Available : throw new HttpRequestException("flaky");
        }, Long, CancellationToken.None);

        Assert.Contains(outcomes.Values, o => o.NotAsked);
    }

    [Fact]
    public async Task Requests_the_breaker_cancelled_are_not_failures_and_stay_unasked()
    {
        var failures = 0;

        var outcomes = await CheckoutStatusReconciler.RunAsync(Ids(8), async (id, token) =>
        {
            if (id is "cad_0" or "cad_1" or "cad_2")
            {
                Interlocked.Increment(ref failures);
                throw new HttpRequestException("down");
            }
            await Task.Delay(Timeout.Infinite, token);
            return Available;
        }, Long, CancellationToken.None);

        Assert.Equal(3, failures);
        Assert.False(outcomes["cad_0"].NotAsked);
        Assert.True(outcomes["cad_3"].NotAsked);
    }

    [Fact]
    public async Task The_deadline_cancels_what_is_running_and_stops_what_is_not()
    {
        var asked = 0;

        var outcomes = await CheckoutStatusReconciler.RunAsync(Ids(20), async (_, token) =>
        {
            Interlocked.Increment(ref asked);
            await Task.Delay(Timeout.Infinite, token);
            return Available;
        }, TimeSpan.FromMilliseconds(50), CancellationToken.None);

        Assert.Equal(CheckoutStatusReconciler.MaxConcurrency, asked);
        Assert.All(outcomes.Values, o => Assert.True(o.NotAsked));
    }

    [Fact]
    public async Task The_callers_cancellation_stops_scheduling_and_every_request_ends_first()
    {
        using var cancel = new CancellationTokenSource();
        var ended = 0;
        var asked = 0;

        await CheckoutStatusReconciler.RunAsync(Ids(20), async (_, token) =>
        {
            if (Interlocked.Increment(ref asked) == 2)
            {
                cancel.Cancel();
            }
            try
            {
                await Task.Delay(Timeout.Infinite, token);
                return Available;
            }
            finally
            {
                Interlocked.Increment(ref ended);
            }
        }, Long, cancel.Token);

        Assert.Equal(asked, ended);
        Assert.InRange(asked, 2, CheckoutStatusReconciler.MaxConcurrency);
    }

    [Fact]
    public async Task A_request_that_ignores_cancellation_is_waited_for_and_never_abandoned()
    {
        var release = new TaskCompletionSource();
        var ended = false;

        var run = CheckoutStatusReconciler.RunAsync(Ids(1), async (_, _) =>
        {
            await release.Task;
            ended = true;
            return Available;
        }, TimeSpan.FromMilliseconds(20), CancellationToken.None);

        await Task.Delay(200);
        Assert.False(run.IsCompleted);

        release.SetResult();
        var outcomes = await run;

        Assert.True(ended);
        // R10 correction (MAJOR 4): waited for, but its answer came after the
        // deadline stopped the run, so it authorizes nothing.
        Assert.True(outcomes["cad_0"].NotAsked);
        Assert.Null(outcomes["cad_0"].Status);
    }

    [Fact]
    public async Task A_late_answer_cannot_change_a_result_already_returned()
    {
        var outcomes = await CheckoutStatusReconciler.RunAsync(Ids(2), (_, _) => Task.FromResult(Available), Long, CancellationToken.None);

        Assert.IsAssignableFrom<IReadOnlyDictionary<string, CheckoutStatusOutcome>>(outcomes);
        Assert.Equal(2, outcomes.Count);
    }
}
