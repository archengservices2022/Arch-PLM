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
    private static readonly IReadOnlyDictionary<string, FileIdentity> NoRoots = new Dictionary<string, FileIdentity>();

    private readonly IReadOnlyList<HeldLock> _held;
    private IReadOnlyDictionary<string, FileIdentity>? _heldRoots;
    private CommandLock? _owner;
    private int _released;

    internal WorkspaceLockLease(WorkspaceLockPlan plan, IReadOnlyList<HeldLock> held, DateTimeOffset acquiredUtc)
    {
        Plan = plan;
        Targets = plan.Targets;
        _held = held;
        AcquiredUtc = acquiredUtc;
    }

    /// <summary>What this lease was acquired for.</summary>
    internal WorkspaceLockPlan Plan { get; }

    /// <summary>Each lock with the target it was taken for, in acquisition order.</summary>
    internal IReadOnlyList<HeldLock> Held => _held;

    /// <summary>P6 M4.4 Package C: each held workspace root's identity, proved
    ///  through its own held lock file once every lock was held, by target key.
    ///  Empty until proved, and for a plan that holds no workspace.</summary>
    internal IReadOnlyDictionary<string, FileIdentity> HeldRoots => Volatile.Read(ref _heldRoots) ?? NoRoots;

    /// <summary>Recorded once; a second record is a defect, not an update.</summary>
    internal void SetHeldRoots(IReadOnlyDictionary<string, FileIdentity> roots)
    {
        ArgumentNullException.ThrowIfNull(roots);
        if (Interlocked.CompareExchange(ref _heldRoots, roots, null) is not null)
        {
            throw new InvalidOperationException("A lease's held roots are recorded once.");
        }
    }

    /// <summary>From now on this lease ends with its command: see
    ///  <see cref="Dispose"/>.</summary>
    internal void AttachOwner(CommandLock owner) => _owner = owner;

    public IReadOnlyList<LockTarget> Targets { get; }

    public DateTimeOffset AcquiredUtc { get; }

    public bool IsReleased => Volatile.Read(ref _released) == 1;

    /// <summary>Handles whose close threw (each still attempted).</summary>
    public int FailedReleases { get; private set; }

    /// <summary>Releases every handle, unless this lease belongs to a command with
    ///  an operation still running: that operation is relying on it, so the
    ///  command releases it when the operation ends.</summary>
    public void Dispose()
    {
        if (_owner is { } owner)
        {
            owner.Release();
            return;
        }
        ReleaseHandles();
    }

    internal void ReleaseHandles()
    {
        if (Interlocked.Exchange(ref _released, 1) != 0) return;
        FailedReleases = ReleaseAll(_held.Select(h => h.Handle).ToList());
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

/// <summary>One lock, held for one target of the plan.</summary>
internal sealed record HeldLock(LockTarget Target, IDisposable Handle);

/// <summary>P6 M4.4 Package C: a held workspace lock that can say where its file
///  is now, asked of the open handle itself and never of a path.</summary>
internal interface IHeldWorkspaceLockFile
{
    /// <returns>The file's current final path, or null when the handle cannot
    ///  answer.</returns>
    string? FinalPath();
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
    private readonly ILockPathSystem _paths;
    private readonly ILockHandleFactory _handles;
    private readonly TimeProvider _time;

    public WorkspaceLockAcquirer(ILockPathSystem paths, ILockHandleFactory handles, TimeProvider? time = null)
    {
        _paths = paths ?? throw new ArgumentNullException(nameof(paths));
        _handles = handles ?? throw new ArgumentNullException(nameof(handles));
        _time = time ?? TimeProvider.System;
        Planner = new WorkspaceLockPlanner(paths);
    }

    public WorkspaceLockPlanner Planner { get; }

    internal ILockPathSystem Paths => _paths;

    public WorkspaceLockAcquisition TryAcquire(WorkspaceLockRequest request)
    {
        var planned = Planner.Plan(request);
        return planned.Refusal is { } refusal ? new WorkspaceLockAcquisition(null, refusal) : TryAcquire(planned.Plan!);
    }

    /// <summary>Test seam: runs once every lock is held, before anything is
    ///  checked under them.</summary>
    internal Action? AfterAcquire { get; set; }

    public WorkspaceLockAcquisition TryAcquire(WorkspaceLockPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var held = new List<HeldLock>(plan.Targets.Count);
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
                WorkspaceLockLease.ReleaseAll(held.Select(h => h.Handle).ToList());
                throw;
            }
            if (!result.Held)
            {
                WorkspaceLockLease.ReleaseAll(held.Select(h => h.Handle).ToList());
                return new WorkspaceLockAcquisition(null, RefusalFor(plan, target, result.ErrorCode!));
            }
            held.Add(new HeldLock(target, result.Handle!));
        }

        // P6 M4.4 Package C: no one else can see this lease yet, so every way out
        // that does not hand it over releases every handle here, once, in reverse.
        var lease = new WorkspaceLockLease(plan, held, _time.GetUtcNow());
        WorkspaceLockRefusal? refusal;
        try
        {
            AfterAcquire?.Invoke();
            refusal = Planner.Revalidate(plan) ?? CaptureRoots(lease);
        }
        catch
        {
            lease.ReleaseHandles();
            throw;
        }
        if (refusal is not null)
        {
            lease.ReleaseHandles();
            return new WorkspaceLockAcquisition(null, refusal);
        }
        return new WorkspaceLockAcquisition(lease, null);
    }

    /// <summary>P6 M4.4 Package C: every held workspace root, shared or exclusive,
    ///  must be proved through its own lock file, or nothing is admitted.</summary>
    private WorkspaceLockRefusal? CaptureRoots(WorkspaceLockLease lease)
    {
        var roots = new Dictionary<string, FileIdentity>(StringComparer.Ordinal);
        foreach (var held in lease.Held)
        {
            if (held.Target.Scope != LockScope.Workspace)
            {
                continue;
            }
            if (ProveRoot(held) is not { } id)
            {
                return new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockScopeRefused, held.Target.Scope, held.Target.Mode, held.Target.DisplayPath);
            }
            roots[held.Target.Key] = id;
        }
        lease.SetHeldRoots(roots);
        return null;
    }

    /// <summary>
    /// P6 M4.4 Package C: the identity of the folder that holds this very lock,
    /// or null when that cannot be proved. The held handle must say its file is
    /// <c>&lt;root&gt;\.arch\locks\workspace.lock</c> before and after the root is
    /// read, so the root read in between is the folder around the held file - also
    /// for a root that the lock itself created. The root must be an existing
    /// folder at exactly that path, with a known identity, and the same identity
    /// planning saw if it existed then. Anything unexpected proves nothing.
    /// </summary>
    internal FileIdentity? ProveRoot(HeldLock held)
    {
        try
        {
            var target = held.Target;
            if (target.Scope != LockScope.Workspace || held.Handle is not IHeldWorkspaceLockFile file)
            {
                return null;
            }
            var expected = LockPaths.WorkspaceLockFile(target.Key);
            if (file.FinalPath() is not { } before || !LockPaths.AreSame(before, expected))
            {
                return null;
            }
            var root = _paths.Resolve(target.Key);
            if (!root.IsResolved || !root.Exists || !root.IsDirectory || root.Id is not { } id
                || !LockPaths.AreSame(root.Canonical, target.Key))
            {
                return null;
            }
            if (target.Identity is { Exists: true } planned && planned.Id != id)
            {
                return null;
            }
            if (file.FinalPath() is not { } after || !LockPaths.AreSame(after, expected))
            {
                return null;
            }
            return id;
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            return null;
        }
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
