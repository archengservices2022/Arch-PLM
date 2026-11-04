using System.Diagnostics;
using Arch.CadConnect.Core.Diagnostics;

namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>The outcome of <see cref="CommandLockGate.Admit"/>: the held
///  locks, or why the command must not run.</summary>
public sealed record CommandLockAdmission(CommandLock? Lock, WorkspaceLockRefusal? LockRefusal)
{
    /// <summary>The M4.1 origin check refused (before or while locked); the
    ///  check itself has already reported it.</summary>
    public bool OriginRefused => Lock is null && LockRefusal is null;
}

/// <summary>
/// P6 M4.4: the ONE place a mutating command (Get Latest, Checkout, Check In,
/// Undo Checkout, Copy Design Apply / Resume / Recover) takes its locks, in
/// the approved order:
/// <list type="number">
/// <item>the M4.1 server-origin check - a refusal here takes NO lock and
///  creates NO lock artifact;</item>
/// <item>path classification, nesting and overlap rules, then the complete
///  lease, with the workspace identity / canonical paths revalidated under
///  it (<see cref="WorkspaceLockAcquirer"/>);</item>
/// <item>the origin check AGAIN, while locked - the binding cannot change
///  between check and use any more.</item>
/// </list>
/// Every refusal happens before the command's first server request. The
/// caller then starts its diagnostics attempt, attaches it, and runs its
/// background work through <see cref="CommandLock.Queue"/>, which releases
/// the lease in the work's own <c>finally</c> - or at once if the work could
/// not even be queued.
/// </summary>
public sealed class CommandLockGate
{
    private readonly WorkspaceLockAcquirer _acquirer;
    private readonly IDiagnosticsSink? _diagnostics;
    private readonly TimeProvider _time;

    public CommandLockGate(WorkspaceLockAcquirer acquirer, IDiagnosticsSink? diagnostics, TimeProvider? time = null)
    {
        _acquirer = acquirer ?? throw new ArgumentNullException(nameof(acquirer));
        _diagnostics = diagnostics;
        _time = time ?? TimeProvider.System;
    }

    /// <param name="originAllowed">The command's M4.1 origin check (it reports
    ///  its own refusal). Run once before any lock is touched and once more
    ///  while every lock is held.</param>
    public CommandLockAdmission Admit(WorkspaceLockRequest request, Func<bool> originAllowed)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(originAllowed);

        if (!originAllowed())
        {
            return new CommandLockAdmission(null, null);
        }

        var started = Stopwatch.GetTimestamp();
        WorkspaceLockAcquisition acquisition;
        try
        {
            acquisition = _acquirer.TryAcquire(request);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // FAIL CLOSED: anything unexpected while resolving or locking (the
            // acquirer has already released what it took) refuses the command.
            acquisition = new WorkspaceLockAcquisition(null, new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockUnavailable));
        }
        if (!acquisition.Acquired)
        {
            WorkspaceLockDiagnostics.Refusal(_diagnostics, request.Command, acquisition.Refusal!, _time);
            return new CommandLockAdmission(null, acquisition.Refusal);
        }

        var lease = acquisition.Lease!;
        bool stillAllowed;
        try
        {
            stillAllowed = originAllowed();
        }
        catch
        {
            lease.Dispose();
            throw;
        }
        if (!stillAllowed)
        {
            lease.Dispose();
            return new CommandLockAdmission(null, null);
        }
        return new CommandLockAdmission(new CommandLock(lease, _acquirer, (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, _time), null);
    }
}

/// <summary>
/// P6 M4.4: the locks of ONE running command. Released EXACTLY ONCE - by the
/// work's own <c>finally</c> (success, refusal, exception, cancellation,
/// timeout), or at once when the work could not be queued - and only then is
/// the release recorded in the command's diagnostics attempt.
///
/// P6 M4.4 Package C: a command admits exactly one operation, once, and is
/// released only when that operation has ended. All of this state moves under
/// <see cref="_gate"/>, and no file is touched while holding it:
/// <list type="table">
/// <item><term>Open</term><description>admits one operation -&gt; Active;
///  released -&gt; Released</description></item>
/// <item><term>Active</term><description>operation ends -&gt; Spent; released
///  -&gt; Closing, and the handles stay held</description></item>
/// <item><term>Spent</term><description>admits nothing; released -&gt; Released</description></item>
/// <item><term>Closing</term><description>admits nothing; operation ends -&gt;
///  Released</description></item>
/// <item><term>Released</term><description>admits nothing; final</description></item>
/// </list>
/// </summary>
public sealed class CommandLock : IDisposable
{
    private enum Stage
    {
        Open,
        Active,
        Spent,
        Closing,
        Released,
    }

    private readonly object _gate = new();
    private readonly WorkspaceLockAcquirer _acquirer;
    private readonly TimeProvider _time;
    private DiagnosticsAttempt? _attempt;
    private Stage _stage = Stage.Open;
    private int _handedOff;

    internal CommandLock(WorkspaceLockLease lease, WorkspaceLockAcquirer acquirer, long acquireMilliseconds, TimeProvider time)
    {
        Lease = lease;
        _acquirer = acquirer;
        AcquireMilliseconds = acquireMilliseconds;
        _time = time;
        lease.AttachOwner(this);
    }

    public WorkspaceLockLease Lease { get; }

    public long AcquireMilliseconds { get; }

    public bool IsReleased
    {
        get
        {
            lock (_gate)
            {
                return _stage == Stage.Released;
            }
        }
    }

    /// <summary>The current stage, for tests and diagnostics only.</summary>
    internal string StageName
    {
        get
        {
            lock (_gate)
            {
                return _stage.ToString();
            }
        }
    }

    /// <summary>True once <see cref="Queue"/> handed the work to the background
    ///  runner - from then on only the work's own <c>finally</c> releases.</summary>
    public bool IsQueued => Volatile.Read(ref _handedOff) == 1;

    /// <summary>A scope for the code between acquiring the locks and queueing
    ///  the work (<c>using var … = held.ReleaseUnlessQueued();</c>): when it
    ///  ends WITHOUT the work having been queued - an exception while
    ///  preparing, an early return - the locks are released. After a
    ///  successful <see cref="Queue"/> it does nothing.</summary>
    public IDisposable ReleaseUnlessQueued() => new StartScope(this);

    /// <summary>Records <c>lock.acquired</c> in the command's attempt, which
    ///  then also receives <c>lock.released</c>.</summary>
    public void AttachDiagnostics(DiagnosticsAttempt? attempt)
    {
        _attempt = attempt;
        try { WorkspaceLockDiagnostics.Acquired(attempt, Lease, AcquireMilliseconds); }
        catch { /* best-effort */ }
    }

    /// <summary>Hand the work to <paramref name="enqueue"/> (the caller's
    ///  background runner) wrapped so the locks are released in its own
    ///  <c>finally</c>. If enqueueing itself throws, the locks are released
    ///  before the exception propagates.</summary>
    public void Queue(Action<Func<CancellationToken, Task>> enqueue, Func<CancellationToken, Task> work)
    {
        ArgumentNullException.ThrowIfNull(enqueue);
        ArgumentNullException.ThrowIfNull(work);
        if (IsQueued || IsReleased)
        {
            throw new InvalidOperationException("A command's locks run exactly one piece of work.");
        }
        try
        {
            enqueue(ct => RunAsync(work, ct));
            Volatile.Write(ref _handedOff, 1);
        }
        catch
        {
            Release();
            throw;
        }
    }

    /// <summary>Runs <paramref name="work"/> to completion - every await -
    ///  holding the locks, and releases them afterwards whatever happened. An
    ///  operation it starts may borrow them; see <see cref="TryBorrow"/>.</summary>
    public async Task RunAsync(Func<CancellationToken, Task> work, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(work);
        var previous = WorkspaceCommandScope.Current;
        WorkspaceCommandScope.Current = this;
        try
        {
            await work(ct).ConfigureAwait(false);
        }
        finally
        {
            WorkspaceCommandScope.Current = previous;
            Release();
        }
    }

    /// <summary>Test seam: runs as an operation asks for admission, before the
    ///  gated decision.</summary>
    internal Action? BeforeAdmission { get; set; }

    /// <summary>Test seam: runs just after a self-acquired operation restored the
    ///  ambient scope.</summary>
    internal Action? AfterAmbientRestored { get; set; }

    /// <summary>
    /// P6 M4.4 Package C: THE admission decision, one step under the gate: only
    /// an Open command whose lease is not released becomes Active, and that is
    /// consumed for good. Nothing ever moves Spent, Closing or Released back to
    /// Active.
    /// </summary>
    /// <returns>True only for the one caller that took admission: that caller, and
    ///  no other, ends it.</returns>
    private bool TryEnterAdmission()
    {
        BeforeAdmission?.Invoke();
        lock (_gate)
        {
            if (_stage != Stage.Open || Lease.IsReleased)
            {
                return false;
            }
            _stage = Stage.Active;
            return true;
        }
    }

    /// <summary>
    /// Runs one operation that took these locks for itself: it is this command's
    /// one admission, so nothing it starts can borrow them too. The held roots are
    /// proved again before the operation runs.
    /// <para>P6 M4.4 Package C: only the invocation that took admission ends it and
    /// releases. One refused at admission touches nothing - the command belongs to
    /// whoever holds it. Once admission is taken, every way out (a refusal, the
    /// refusal factory throwing, the operation throwing, restoring the ambient
    /// scope throwing) ends admission and releases, exactly once.</para>
    /// </summary>
    internal async Task<T> RunAdmittedAsync<T>(
        WorkspaceLockRequest expected,
        Func<Task<T>> operation,
        Func<WorkspaceLockRefusal, Exception> refused)
    {
        if (!TryEnterAdmission())
        {
            throw refused(new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockScopeRefused));
        }

        var ended = false;
        void EndOwned()
        {
            if (ended)
            {
                return;
            }
            ended = true;
            try
            {
                EndAdmission();
            }
            finally
            {
                Release();
            }
        }

        try
        {
            if (SafeVerify(expected) is { } refusal)
            {
                EndOwned();
                throw refused(refusal);
            }
            var previous = WorkspaceCommandScope.Current;
            WorkspaceCommandScope.Current = this;
            try
            {
                return await operation().ConfigureAwait(false);
            }
            finally
            {
                WorkspaceCommandScope.Current = previous;
                AfterAmbientRestored?.Invoke();
            }
        }
        finally
        {
            EndOwned();
        }
    }

    /// <summary>
    /// Admits the one operation of this command, or says why not. Admission is
    /// taken first and is spent even if what follows fails, so a refused operation
    /// cannot be retried and two cannot both pass. Only then is everything the
    /// ambient hint implied proved: an exclusive hold on this operation's own
    /// target, of the same kind, on a root that is still the very folder locked,
    /// with its binding unchanged.
    /// </summary>
    /// <returns>Null when admitted: the caller must call
    ///  <see cref="EndAdmission"/>. A caller refused before admission was taken
    ///  must not: the command is not its to end.</returns>
    internal WorkspaceLockRefusal? TryBorrow(WorkspaceLockRequest expected)
    {
        if (!TryEnterAdmission())
        {
            return new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockScopeRefused);
        }

        // Admission is this caller's from here: a failed proof ends it here.
        var refusal = SafeVerify(expected);
        if (refusal is not null)
        {
            EndAdmission();
        }
        return refusal;
    }

    private WorkspaceLockRefusal? SafeVerify(WorkspaceLockRequest expected)
    {
        try
        {
            return Verify(expected);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockScopeRefused);
        }
    }

    private WorkspaceLockRefusal? Verify(WorkspaceLockRequest expected)
    {
        var plan = Lease.Plan;
        var refused = new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockScopeRefused);
        if (plan.Request.Kind != expected.Kind
            || plan.Request.TargetPath is not { } planned
            || expected.TargetPath is not { } wanted)
        {
            return refused;
        }

        var paths = _acquirer.Paths;
        var plannedTarget = paths.Resolve(planned);
        var wantedTarget = paths.Resolve(wanted);
        if (!plannedTarget.IsResolved || !wantedTarget.IsResolved || !LockPaths.AreSame(plannedTarget.Canonical, wantedTarget.Canonical))
        {
            return refused;
        }

        // P6 M4.4 Package C: each root is proved again through the very lock file
        // held for it, and must still be the folder proved when the locks were taken.
        var held = Lease.Held.Where(h => h.Target.Scope == LockScope.Workspace).ToList();
        if (held.Count == 0)
        {
            return refused;
        }
        foreach (var lockHeld in held)
        {
            if (lockHeld.Target.Mode != LockMode.Exclusive
                || !Lease.HeldRoots.TryGetValue(lockHeld.Target.Key, out var identity)
                || _acquirer.ProveRoot(lockHeld) is not { } now
                || now != identity)
            {
                return refused;
            }
        }
        return _acquirer.Planner.Revalidate(plan);
    }

    /// <summary>The admitted operation has ended: never admits another, and
    ///  performs the release if one has been waiting for this.</summary>
    internal void EndAdmission()
    {
        lock (_gate)
        {
            switch (_stage)
            {
                case Stage.Active:
                    _stage = Stage.Spent;
                    return;
                case Stage.Closing:
                    _stage = Stage.Released;
                    break;
                default:
                    return;
            }
        }
        ReleaseHandles();
    }

    /// <summary>Releases the locks, once. While an operation is running they are
    ///  released when it ends, whichever comes last.</summary>
    public void Release()
    {
        lock (_gate)
        {
            switch (_stage)
            {
                case Stage.Active:
                    _stage = Stage.Closing;
                    return;
                case Stage.Closing:
                case Stage.Released:
                    return;
                default:
                    _stage = Stage.Released;
                    break;
            }
        }
        ReleaseHandles();
    }

    private void ReleaseHandles()
    {
        Lease.ReleaseHandles();
        try { WorkspaceLockDiagnostics.Released(_attempt, Lease, _time.GetUtcNow()); }
        catch { /* best-effort */ }
    }

    public void Dispose() => Release();

    private sealed class StartScope(CommandLock owner) : IDisposable
    {
        public void Dispose()
        {
            if (!owner.IsQueued) owner.Release();
        }
    }
}
