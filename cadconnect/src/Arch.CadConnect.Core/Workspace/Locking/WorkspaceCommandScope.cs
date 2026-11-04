namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>
/// P6 M4.4 Package C: how one workspace operation comes to run under the
/// workspace lock, whoever called it. The lock cannot be taken twice in a process,
/// and the add-in takes it long before the operation starts, so an operation first
/// asks whether it is already running inside a command:
/// <list type="bullet">
/// <item>No command in scope: this operation takes the lock itself, through the
///  same gate as every command, and holds it until it ends.</item>
/// <item>A command in scope: this operation borrows that command's lock. The
///  ambient value is only a hint that may have been inherited by any task, so
///  <see cref="CommandLock.TryBorrow"/> proves everything again.</item>
/// <item>A borrow refused: the operation stops. It never falls back to taking the
///  lock itself: something is wrong with this flow, and asking again would hide
///  it.</item>
/// </list>
/// One command admits exactly one operation, ever. Child tasks are otherwise free
/// to run, and a command's lock stays held until its admitted operation has ended.
/// </summary>
public static class WorkspaceCommandScope
{
    private static readonly AsyncLocal<CommandLock?> Ambient = new();

    internal static CommandLock? Current
    {
        get => Ambient.Value;
        set => Ambient.Value = value;
    }

    /// <summary>Runs <paramref name="operation"/> under the workspace lock.</summary>
    /// <param name="request">What this operation needs locked.</param>
    /// <param name="guard">Throws if the operation must not run. Runs before any
    ///  lock is touched, and again under the lock.</param>
    /// <param name="refused">Turns a lock refusal into the caller's exception.</param>
    public static async Task<T> RunAsync<T>(
        WorkspaceLockRequest request,
        Action guard,
        Func<Task<T>> operation,
        Func<WorkspaceLockRefusal, Exception> refused)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(guard);
        ArgumentNullException.ThrowIfNull(operation);
        ArgumentNullException.ThrowIfNull(refused);

        if (Current is { } command)
        {
            // Refused: this caller never held admission, so it ends nothing.
            if (command.TryBorrow(request) is { } refusal)
            {
                throw refused(refusal);
            }
            // Admitted: this caller, and only this caller, ends it.
            try
            {
                guard();
                return await operation().ConfigureAwait(false);
            }
            finally
            {
                command.EndAdmission();
            }
        }

        if (!OperatingSystem.IsWindows())
        {
            throw refused(new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockUnavailable));
        }

        // A refusal here takes no lock and leaves no lock artifact.
        guard();
        var gate = new CommandLockGate(new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), diagnostics: null);
        var admission = gate.Admit(request, () =>
        {
            guard();
            return true;
        });
        if (admission.Lock is not { } held)
        {
            throw refused(admission.LockRefusal ?? new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockUnavailable));
        }
        return await held.RunAdmittedAsync(request, operation, refused).ConfigureAwait(false);
    }
}
