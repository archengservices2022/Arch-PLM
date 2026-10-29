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
        return new CommandLockAdmission(new CommandLock(lease, (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, _time), null);
    }
}

/// <summary>
/// P6 M4.4: the locks of ONE running command. Released EXACTLY ONCE - by the
/// work's own <c>finally</c> (success, refusal, exception, cancellation,
/// timeout), or at once when the work could not be queued - and only then is
/// the release recorded in the command's diagnostics attempt.
/// </summary>
public sealed class CommandLock : IDisposable
{
    private readonly TimeProvider _time;
    private DiagnosticsAttempt? _attempt;
    private int _released;
    private int _handedOff;

    internal CommandLock(WorkspaceLockLease lease, long acquireMilliseconds, TimeProvider time)
    {
        Lease = lease;
        AcquireMilliseconds = acquireMilliseconds;
        _time = time;
    }

    public WorkspaceLockLease Lease { get; }

    public long AcquireMilliseconds { get; }

    public bool IsReleased => Volatile.Read(ref _released) == 1;

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
    ///  holding the locks, and releases them afterwards whatever happened.</summary>
    public async Task RunAsync(Func<CancellationToken, Task> work, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(work);
        try
        {
            await work(ct).ConfigureAwait(false);
        }
        finally
        {
            Release();
        }
    }

    public void Release()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0) return;
        Lease.Dispose();
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
