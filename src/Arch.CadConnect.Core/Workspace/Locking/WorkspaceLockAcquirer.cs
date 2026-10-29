namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>
/// P6 M4.4: every lock of one command, held together and released together
/// - EXACTLY ONCE, in reverse acquisition order, each handle on its own so a
/// failing close never skips the rest. The owner keeps it reachable for the
/// whole command (the work closure disposes it in its own <c>finally</c>),
/// so no handle can be closed early by collection.
/// </summary>
public sealed class WorkspaceLockLease : IDisposable
{
    private readonly IReadOnlyList<IDisposable> _handles;
    private int _released;

    internal WorkspaceLockLease(IReadOnlyList<LockTarget> targets, IReadOnlyList<IDisposable> handles, DateTimeOffset acquiredUtc)
    {
        Targets = targets;
        _handles = handles;
        AcquiredUtc = acquiredUtc;
    }

    public IReadOnlyList<LockTarget> Targets { get; }

    public DateTimeOffset AcquiredUtc { get; }

    public bool IsReleased => Volatile.Read(ref _released) == 1;

    /// <summary>Handles whose close threw (each still attempted).</summary>
    public int FailedReleases { get; private set; }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0) return;
        FailedReleases = ReleaseAll(_handles);
    }

    internal static int ReleaseAll(IReadOnlyList<IDisposable> handles)
    {
        var failed = 0;
        for (var i = handles.Count - 1; i >= 0; i--)
        {
            try
            {
                handles[i].Dispose();
            }
            catch
            {
                failed++;
            }
        }
        return failed;
    }
}

public sealed record WorkspaceLockAcquisition(WorkspaceLockLease? Lease, WorkspaceLockRefusal? Refusal)
{
    public bool Acquired => Lease is not null;
}

/// <summary>
/// P6 M4.4: takes a plan's locks IN PLAN ORDER, each with one non-waiting
/// try. The first lock that cannot be taken releases every lock already
/// taken and refuses the command - no instance ever waits while holding a
/// lock, so two instances can never deadlock. Once every lock is held, the
/// request is planned AGAIN and must yield the same locks over the same,
/// unchanged paths and workspace bindings (a folder swapped, a manifest
/// created, removed or re-bound between validation and acquisition refuses).
/// Locks only keep running processes apart: nothing here provides
/// idempotency or recovery - those stay with the server and Resume/Recover.
/// </summary>
public sealed class WorkspaceLockAcquirer
{
    private readonly ILockHandleFactory _handles;
    private readonly TimeProvider _time;

    public WorkspaceLockAcquirer(ILockPathSystem paths, ILockHandleFactory handles, TimeProvider? time = null)
    {
        ArgumentNullException.ThrowIfNull(paths);
        _handles = handles ?? throw new ArgumentNullException(nameof(handles));
        _time = time ?? TimeProvider.System;
        Planner = new WorkspaceLockPlanner(paths);
    }

    public WorkspaceLockPlanner Planner { get; }

    public WorkspaceLockAcquisition TryAcquire(WorkspaceLockRequest request)
    {
        var planned = Planner.Plan(request);
        return planned.Refusal is { } refusal ? new WorkspaceLockAcquisition(null, refusal) : TryAcquire(planned.Plan!);
    }

    public WorkspaceLockAcquisition TryAcquire(WorkspaceLockPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var held = new List<IDisposable>(plan.Targets.Count);
        foreach (var target in plan.Targets)
        {
            LockHandleResult result;
            try
            {
                result = target.Scope == LockScope.Workspace
                    ? _handles.AcquireWorkspace(target.Key, target.Mode, WorkspaceLockHolderRecord.ForCurrentProcess(plan.Request.Command, target.Mode, _time))
                    : _handles.AcquireMachine(target.Scope, target.Key);
            }
            catch
            {
                WorkspaceLockLease.ReleaseAll(held);
                throw;
            }
            if (!result.Held)
            {
                WorkspaceLockLease.ReleaseAll(held);
                return new WorkspaceLockAcquisition(null, RefusalFor(plan, target, result.ErrorCode!));
            }
            held.Add(result.Handle!);
        }

        var lease = new WorkspaceLockLease(plan.Targets, held, _time.GetUtcNow());
        WorkspaceLockRefusal? changed;
        try
        {
            changed = Planner.Revalidate(plan);
        }
        catch
        {
            lease.Dispose();
            throw;
        }
        if (changed is not null)
        {
            lease.Dispose();
            return new WorkspaceLockAcquisition(null, changed);
        }
        return new WorkspaceLockAcquisition(lease, null);
    }

    private WorkspaceLockRefusal RefusalFor(WorkspaceLockPlan plan, LockTarget target, string errorCode)
    {
        WorkspaceLockHolderRecord? holder = null;
        if (target.Scope == LockScope.Workspace && errorCode == WorkspaceLockErrorCodes.WorkspaceLocked)
        {
            // Display only: named only when that process is alive on THIS machine.
            var record = SafeReadHolder(target.Key);
            holder = record is not null && record.IsLiveOnThisMachine() ? record : null;
        }
        return new WorkspaceLockRefusal(
            errorCode,
            target.Scope,
            target.Mode,
            target.DisplayPath,
            Locality: null,
            IdempotencyKey: target.Scope == LockScope.Operation ? plan.Request.IdempotencyKey : null,
            Holder: holder,
            HolderProcessId: holder?.ProcessId);
    }

    private WorkspaceLockHolderRecord? SafeReadHolder(string root)
    {
        try { return _handles.ReadHolder(root); }
        catch { return null; }
    }
}
