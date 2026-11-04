using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Workspace;

/// <summary>What became of one status question.</summary>
/// <param name="Status">The server's valid answer, or null.</param>
/// <param name="NotAsked">True when no answer exists because the run stopped asking
///  (deadline or breaker), not because the server's answer was unusable.</param>
internal readonly record struct CheckoutStatusOutcome(ServerCheckoutStatus? Status, bool NotAsked);

/// <summary>Test seams for <see cref="CheckoutStatusReconciler"/>; all null in
///  production.</summary>
/// <param name="BeforeWait">Runs before the scheduler waits for a slot for an item;
///  throwing simulates the scheduler itself failing.</param>
/// <param name="StartWorker">Runs as an admitted item's worker is started; throwing
///  simulates the start failing.</param>
/// <param name="AfterAdmission">Runs in an admitted item's worker before its last
///  cancellation check.</param>
/// <param name="OnStopLatched">Runs once, outside the gate, when the run first
///  latches its stop.</param>
/// <param name="OnClosed">Runs with the free permit count once every worker has
///  been joined.</param>
internal sealed record CheckoutStatusReconcilerHooks(
    Action<int>? BeforeWait = null,
    Action<int>? StartWorker = null,
    Action<int>? AfterAdmission = null,
    Action? OnStopLatched = null,
    Action<int>? OnClosed = null);

/// <summary>
/// P6 M4.4 Package C: asks the server about every document in a set, at most
/// <see cref="MaxConcurrency"/> at a time, and returns only when no request is
/// still running.
/// <list type="bullet">
/// <item>Every slot wait and every request uses one token linking the caller, the
///  deadline and the breaker.</item>
/// <item>The breaker opens on the third genuine failure in a run and never resets.
///  A request cancelled by the deadline, the breaker or the caller is not a
///  failure, and counts towards nothing.</item>
/// <item>R10 correction (MAJOR 4): one gate holds the whole decision. The run's
///  stop is latched under it and never clears; admission under it is the
///  scheduling linearization point - a stop before admission means the item never
///  runs, and an admitted item's answer counts only if it completed before the
///  stop. An answer or failure that completes after the stop is never recorded or
///  counted, so a late answer can never authorize anything.</item>
/// <item>Requests, awaits, cancelling the breaker, cancellation callbacks and
///  disposing their registrations all happen outside the gate.</item>
/// <item>Every admitted item is tracked, its permit released exactly once, and
///  every started worker awaited, with no token, before this returns - even when
///  scheduling throws. So the deadline stops new work and cancels running work,
///  but it is NOT a hard bound on elapsed time: a request that ignores
///  cancellation is waited for, for as long as it takes, with the workspace lock
///  still held. A running request is never abandoned.</item>
/// </list>
/// Who stopped the run is decided by the caller: its own token, checked after this
/// returns, outranks everything here.
/// </summary>
internal static class CheckoutStatusReconciler
{
    public const int MaxConcurrency = 4;
    public const int BreakerFailures = 3;

    public static readonly TimeSpan DefaultDeadline = TimeSpan.FromSeconds(60);

    public static Task<IReadOnlyDictionary<string, CheckoutStatusOutcome>> RunAsync(
        IReadOnlyList<string> cadDocumentIds,
        Func<string, CancellationToken, Task<ServerCheckoutStatus>> query,
        TimeSpan deadline,
        CancellationToken ct) => RunAsync(cadDocumentIds, query, deadline, ct, hooks: null);

    internal static async Task<IReadOnlyDictionary<string, CheckoutStatusOutcome>> RunAsync(
        IReadOnlyList<string> cadDocumentIds,
        Func<string, CancellationToken, Task<ServerCheckoutStatus>> query,
        TimeSpan deadline,
        CancellationToken ct,
        CheckoutStatusReconcilerHooks? hooks)
    {
        if (cadDocumentIds.Count == 0)
        {
            return new Dictionary<string, CheckoutStatusOutcome>(StringComparer.Ordinal);
        }

        using var deadlineSource = new CancellationTokenSource(deadline);
        using var breaker = new CancellationTokenSource();
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, deadlineSource.Token, breaker.Token);
        using var capacity = new SemaphoreSlim(MaxConcurrency, MaxConcurrency);
        var run = new Run(cadDocumentIds.Count, linked.Token, hooks?.OnStopLatched);
        // Latches the stop the moment the caller, the deadline or the breaker
        // cancels, independently of any worker or of the scheduler. Disposed, by
        // the using, outside the gate.
        using var stopOnCancel = linked.Token.Register(run.Latch);

        async Task Work(Reservation reservation)
        {
            try
            {
                hooks?.AfterAdmission?.Invoke(reservation.Index);
                // Last check before invoking: a stop since admission means this
                // request is never sent.
                if (run.StoppedNow())
                {
                    return;
                }
                ServerCheckoutStatus status;
                try
                {
                    status = await query(cadDocumentIds[reservation.Index], linked.Token).ConfigureAwait(false);
                }
                catch (Exception)
                {
                    if (run.CountFailure(reservation.Index))
                    {
                        breaker.Cancel();
                    }
                    return;
                }
                run.Answer(reservation.Index, status);
            }
            finally
            {
                reservation.ReleasePermit(capacity);
            }
        }

        var started = new List<Task>(cadDocumentIds.Count);
        try
        {
            for (var i = 0; i < cadDocumentIds.Count; i++)
            {
                hooks?.BeforeWait?.Invoke(i);
                try
                {
                    await capacity.WaitAsync(linked.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    run.Latch();
                    break;
                }

                if (!run.TryAdmit())
                {
                    capacity.Release();
                    break;
                }

                var reservation = new Reservation(i);
                try
                {
                    hooks?.StartWorker?.Invoke(i);
                    started.Add(Task.Run(() => Work(reservation), CancellationToken.None));
                }
                catch (Exception)
                {
                    // Admitted but never started: its slot stays NotAsked and its
                    // permit is returned here, once; the run stops.
                    reservation.ReleasePermit(capacity);
                    run.Latch();
                    break;
                }
            }
        }
        finally
        {
            // Every started worker ends before anything is decided - also when
            // scheduling threw. Workers never throw.
            await Task.WhenAll(started).ConfigureAwait(false);
        }

        var outcomes = run.Close(cadDocumentIds);
        hooks?.OnClosed?.Invoke(capacity.CurrentCount);
        return outcomes;
    }

    /// <summary>One admitted item; its slot permit is returned exactly once.</summary>
    private sealed class Reservation(int index)
    {
        private int _released;

        public int Index { get; } = index;

        public void ReleasePermit(SemaphoreSlim capacity)
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                capacity.Release();
            }
        }
    }

    /// <summary>Everything a run decides, under one gate. Nothing in here waits,
    ///  sends, cancels or disposes.</summary>
    private sealed class Run
    {
        private readonly object _gate = new();
        private readonly CheckoutStatusOutcome[] _slots;
        private readonly CancellationToken _linked;
        private readonly Action? _onStopLatched;
        private bool _stopped;
        private bool _closed;
        private int _failures;

        public Run(int count, CancellationToken linked, Action? onStopLatched)
        {
            _slots = new CheckoutStatusOutcome[count];
            Array.Fill(_slots, new CheckoutStatusOutcome(null, NotAsked: true));
            _linked = linked;
            _onStopLatched = onStopLatched;
        }

        public void Latch()
        {
            bool first;
            lock (_gate)
            {
                first = LatchLocked();
            }
            Notify(first);
        }

        /// <summary>Whether the run has stopped, latching a cancellation seen now.</summary>
        public bool StoppedNow()
        {
            bool stopped, first;
            lock (_gate)
            {
                first = ObserveLocked();
                stopped = _stopped;
            }
            Notify(first);
            return stopped;
        }

        /// <summary>The scheduling linearization point.</summary>
        public bool TryAdmit() => !StoppedNow();

        public void Answer(int index, ServerCheckoutStatus status)
        {
            bool first;
            lock (_gate)
            {
                RequireOpen();
                first = ObserveLocked();
                if (!_stopped)
                {
                    _slots[index] = new CheckoutStatusOutcome(status, NotAsked: false);
                }
            }
            Notify(first);
        }

        /// <returns>True for the one failure that opened the breaker.</returns>
        public bool CountFailure(int index)
        {
            bool first, opened = false;
            lock (_gate)
            {
                RequireOpen();
                first = ObserveLocked();
                if (!_stopped)
                {
                    _slots[index] = new CheckoutStatusOutcome(null, NotAsked: false);
                    if (++_failures == BreakerFailures)
                    {
                        first = LatchLocked() || first;
                        opened = true;
                    }
                }
            }
            Notify(first);
            return opened;
        }

        public IReadOnlyDictionary<string, CheckoutStatusOutcome> Close(IReadOnlyList<string> ids)
        {
            lock (_gate)
            {
                _closed = true;
                var outcomes = new Dictionary<string, CheckoutStatusOutcome>(StringComparer.Ordinal);
                for (var i = 0; i < _slots.Length; i++)
                {
                    outcomes[ids[i]] = _slots[i];
                }
                return outcomes;
            }
        }

        private bool ObserveLocked() => _linked.IsCancellationRequested && LatchLocked();

        private bool LatchLocked()
        {
            if (_stopped)
            {
                return false;
            }
            _stopped = true;
            return true;
        }

        private void RequireOpen()
        {
            if (_closed)
            {
                throw new InvalidOperationException("A status run's result was written after it was closed.");
            }
        }

        private void Notify(bool first)
        {
            if (first)
            {
                _onStopLatched?.Invoke();
            }
        }
    }
}
