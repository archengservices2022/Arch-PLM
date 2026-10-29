using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>The result of trying ONE lock: a handle to keep, or why not.</summary>
public readonly record struct LockHandleResult(IDisposable? Handle, string? ErrorCode)
{
    public bool Held => Handle is not null;

    public static LockHandleResult Acquired(IDisposable handle) => new(handle, null);

    public static LockHandleResult Refused(string errorCode) => new(null, errorCode);
}

/// <summary>Takes single locks - never waits, never retries.</summary>
public interface ILockHandleFactory
{
    LockHandleResult AcquireWorkspace(string canonicalRoot, LockMode mode, WorkspaceLockHolderRecord holder);

    LockHandleResult AcquireMachine(LockScope scope, string key);

    /// <summary>The holder record of a workspace lock - for the refusal
    ///  message only, never for a decision.</summary>
    WorkspaceLockHolderRecord? ReadHolder(string canonicalRoot);
}

/// <summary>
/// P6 M4.4: who holds a workspace lock exclusively - written by the holder
/// after it holds the lock, shown to a refused instance, NEVER read by any
/// decision or recovery logic (a stale record changes nothing). Contains no
/// account identity; the machine name is shown to the user but never logged.
/// </summary>
public sealed record WorkspaceLockHolderRecord(
    [property: JsonPropertyName("schema")] string Schema,
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("command")] string Command,
    [property: JsonPropertyName("processId")] int ProcessId,
    [property: JsonPropertyName("processStartedUtc")] DateTimeOffset? ProcessStartedUtc,
    [property: JsonPropertyName("acquiredUtc")] DateTimeOffset AcquiredUtc,
    [property: JsonPropertyName("machineName")] string? MachineName)
{
    public const string SchemaId = "arch-plm.workspace-lock.v1";

    /// <summary>A lock file larger than this is not ours.</summary>
    public const int MaxBytes = 4096;

    public static WorkspaceLockHolderRecord ForCurrentProcess(string command, LockMode mode, TimeProvider? time = null)
    {
        using var self = Process.GetCurrentProcess();
        return new WorkspaceLockHolderRecord(
            SchemaId,
            mode == LockMode.Exclusive ? "exclusive" : "shared",
            command,
            self.Id,
            SafeStartTime(self),
            (time ?? TimeProvider.System).GetUtcNow(),
            SafeMachineName());
    }

    public byte[] Serialize() => JsonSerializer.SerializeToUtf8Bytes(this);

    /// <summary>The record, or null when the bytes are not one of ours.</summary>
    public static WorkspaceLockHolderRecord? TryParse(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length == 0 || bytes.Length > MaxBytes) return null;
        try
        {
            var record = JsonSerializer.Deserialize<WorkspaceLockHolderRecord>(bytes);
            return record is not null && record.Schema == SchemaId ? record : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>True only when the recorded process is running on THIS
    ///  machine and is the same process (same start time) - a re-used process
    ///  id is not the holder.</summary>
    public bool IsLiveOnThisMachine()
    {
        if (!string.Equals(MachineName, SafeMachineName(), StringComparison.OrdinalIgnoreCase) || ProcessStartedUtc is not { } started)
        {
            return false;
        }
        try
        {
            using var process = Process.GetProcessById(ProcessId);
            return SafeStartTime(process) is { } actual && (actual - started).Duration() < TimeSpan.FromSeconds(1);
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static DateTimeOffset? SafeStartTime(Process process)
    {
        try { return new DateTimeOffset(process.StartTime.ToUniversalTime(), TimeSpan.Zero); }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { return null; }
    }

    private static string? SafeMachineName()
    {
        try { return Environment.MachineName; }
        catch (InvalidOperationException) { return null; }
    }
}

/// <summary>
/// P6 M4.4 W lock: an open handle on <c>&lt;root&gt;\.arch\locks\workspace.lock</c>.
/// <list type="bullet">
/// <item>EXCLUSIVE = read/write access, others may only read: every other
///  exclusive or shared open fails with a sharing violation.</item>
/// <item>SHARED = read access, others may only read: shared opens coexist,
///  an exclusive open fails.</item>
/// <item>A reader of the holder record (read access, sharing read+write)
///  never conflicts with either.</item>
/// </list>
/// Windows enforces this for every process and user, locally and for SMB
/// clients of this volume, and closes the handle however the process ends.
/// ARTIFACT RULES: only the <c>locks</c> folder and the lock file are ever
/// created; nothing is truncated on open; nothing is deleted, ever; a link,
/// junction, hard link, foreign content, a folder in the file's place or a
/// file in a folder's place refuses the lock and changes nothing.
/// </summary>
[SupportedOSPlatform("windows")]
public static class WorkspaceFileLock
{
    public const string LockFileName = "workspace.lock";

    private const int SharingViolation = unchecked((int)0x80070020);
    private const int LockViolation = unchecked((int)0x80070021);

    public static string LockFilePath(string root) => Path.Combine(root, ".arch", "locks", LockFileName);

    public static LockHandleResult Acquire(string canonicalRoot, LockMode mode, WorkspaceLockHolderRecord holder)
    {
        ArgumentNullException.ThrowIfNull(holder);
        var archDir = Path.Combine(canonicalRoot, ".arch");
        var locksDir = Path.Combine(archDir, "locks");
        var lockPath = Path.Combine(locksDir, LockFileName);

        if (CheckArtifacts(archDir, locksDir, lockPath) is { } before) return LockHandleResult.Refused(before);
        try
        {
            Directory.CreateDirectory(locksDir);
        }
        catch (UnauthorizedAccessException)
        {
            return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockAccessDenied);
        }
        catch (IOException)
        {
            return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockUnavailable);
        }
        if (CheckArtifacts(archDir, locksDir, lockPath) is { } after) return LockHandleResult.Refused(after);

        FileStream stream;
        try
        {
            stream = new FileStream(lockPath, FileMode.OpenOrCreate,
                mode == LockMode.Exclusive ? FileAccess.ReadWrite : FileAccess.Read,
                FileShare.Read, bufferSize: 1, FileOptions.None);
        }
        catch (IOException ex) when (ex.HResult is SharingViolation or LockViolation)
        {
            return LockHandleResult.Refused(WorkspaceLockErrorCodes.WorkspaceLocked);
        }
        catch (UnauthorizedAccessException)
        {
            return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockAccessDenied);
        }
        catch (IOException)
        {
            return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockUnavailable);
        }

        var keep = false;
        try
        {
            // The OPENED file must be exactly <root>\.arch\locks\workspace.lock:
            // no link swapped in after the checks, no hard link to other data.
            if (!WindowsFileNative.TryQuery(stream.SafeFileHandle, out var final, out var info))
            {
                return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockUnavailable);
            }
            if (!LockPaths.AreSame(final, lockPath) || info.LinkCount != 1 || info.IsReparsePoint
                || (info.Attributes & NativeFileInfo.Directory) != 0)
            {
                return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockPathInvalid);
            }

            // Content: empty or one of our records - never anything else.
            if (stream.Length > WorkspaceLockHolderRecord.MaxBytes)
            {
                return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockForeignContent);
            }
            var existing = new byte[stream.Length];
            stream.Position = 0;
            stream.ReadExactly(existing);
            if (existing.Length > 0 && WorkspaceLockHolderRecord.TryParse(existing) is null)
            {
                return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockForeignContent);
            }

            if (mode == LockMode.Exclusive)
            {
                stream.Position = 0;
                stream.SetLength(0);
                stream.Write(holder.Serialize());
                stream.Flush(flushToDisk: true);
            }
            keep = true;
            return LockHandleResult.Acquired(new Handle(stream));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return LockHandleResult.Refused(WorkspaceLockErrorCodes.LockUnavailable);
        }
        finally
        {
            if (!keep) stream.Dispose();
        }
    }

    /// <summary>The holder record, read with full sharing so it never blocks
    ///  a holder; null when absent, linked, or not ours.</summary>
    public static WorkspaceLockHolderRecord? ReadHolder(string canonicalRoot)
    {
        var lockPath = LockFilePath(canonicalRoot);
        try
        {
            if (!File.Exists(lockPath) || IsLinkOrUnknown(lockPath)) return null;
            using var stream = new FileStream(lockPath, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, bufferSize: 1, FileOptions.None);
            if (stream.Length == 0 || stream.Length > WorkspaceLockHolderRecord.MaxBytes) return null;
            var bytes = new byte[stream.Length];
            stream.ReadExactly(bytes);
            return WorkspaceLockHolderRecord.TryParse(bytes);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string? CheckArtifacts(string archDir, string locksDir, string lockPath)
    {
        foreach (var dir in new[] { archDir, locksDir })
        {
            if (File.Exists(dir)) return WorkspaceLockErrorCodes.LockPathInvalid;
            if (Directory.Exists(dir) && IsLinkOrUnknown(dir)) return WorkspaceLockErrorCodes.LockPathReparse;
        }
        if (Directory.Exists(lockPath)) return WorkspaceLockErrorCodes.LockPathInvalid;
        if (File.Exists(lockPath) && IsLinkOrUnknown(lockPath)) return WorkspaceLockErrorCodes.LockPathReparse;
        return null;
    }

    /// <summary>The path's OWN attributes - from a handle, or (when the file
    ///  itself may not be opened) from its directory entry. A path whose
    ///  attributes cannot be read either way is treated as a link - never
    ///  trusted.</summary>
    private static bool IsLinkOrUnknown(string path)
    {
        if (WindowsFileNative.TryQueryLink(path, out var info)) return info.IsReparsePoint;
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return true;
        }
    }

    private sealed class Handle(FileStream stream) : IDisposable
    {
        public void Dispose() => stream.Dispose();
    }
}

/// <summary>
/// P6 M4.4 O and D locks: a named kernel event in the machine-wide
/// <c>Global\</c> namespace (<c>\BaseNamedObjects</c>, shared by every
/// session and every Windows user).
/// <list type="bullet">
/// <item>OWNERSHIP IS FIRST CREATION: <c>CreateEventExW</c> creates the named
///  object atomically in the object manager - of any number of simultaneous
///  callers exactly one creates it. Only that caller (a valid handle AND a
///  last error other than <c>ERROR_ALREADY_EXISTS</c>) holds the lock.</item>
/// <item><c>ERROR_ALREADY_EXISTS</c> - the object exists, whoever made it -
///  is ALWAYS refused; the extra handle is closed at once.</item>
/// <item><c>ERROR_ACCESS_DENIED</c> - it exists and this user may not open
///  it (another Windows user's, another integrity level's) - is refused as
///  held. Every other failure, including the name being taken by a
///  different object type, fails closed as unavailable.</item>
/// <item>The lock is the object's EXISTENCE, never its signaled state, and
///  handles are opened with <c>SYNCHRONIZE</c> only: a refused contender
///  can neither signal nor reset it, and closing its own handle cannot
///  destroy the object while the holder's handle is open.</item>
/// <item>The object lives exactly as long as its last handle - the holder's
///  lease - and the OS closes that handle however the process ends.</item>
/// </list>
/// No files, no thread affinity (unlike a mutex), no waiting.
/// </summary>
[SupportedOSPlatform("windows")]
public static class MachineNamedLock
{
    public const string NamePrefix = @"Global\ArchCadConnect.Lock.";

    private const uint ManualReset = 0x1;
    private const uint Synchronize = 0x00100000;
    private const int ErrorAccessDenied = 5;
    private const int ErrorAlreadyExists = 183;

    public static string NameFor(LockScope scope, string key)
    {
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)))[..40];
        return NamePrefix + (scope == LockScope.Operation ? "op." : "dst.") + hash;
    }

    public static LockHandleResult Acquire(LockScope scope, string key)
    {
        var locked = WorkspaceLockErrorCodes.LockedFor(scope);
        var handle = CreateEventExW(IntPtr.Zero, NameFor(scope, key), ManualReset, Synchronize);
        var error = Marshal.GetLastPInvokeError();
        if (handle.IsInvalid)
        {
            handle.Dispose();
            return LockHandleResult.Refused(error == ErrorAccessDenied ? locked : WorkspaceLockErrorCodes.LockUnavailable);
        }
        if (error == ErrorAlreadyExists)
        {
            handle.Dispose();
            return LockHandleResult.Refused(locked);
        }
        return LockHandleResult.Acquired(handle);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle CreateEventExW(IntPtr securityAttributes, string name, uint flags, uint desiredAccess);
}

/// <summary>The real <see cref="ILockHandleFactory"/>.</summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsLockHandleFactory : ILockHandleFactory
{
    public static readonly WindowsLockHandleFactory Instance = new();

    public LockHandleResult AcquireWorkspace(string canonicalRoot, LockMode mode, WorkspaceLockHolderRecord holder) =>
        WorkspaceFileLock.Acquire(canonicalRoot, mode, holder);

    public LockHandleResult AcquireMachine(LockScope scope, string key) => MachineNamedLock.Acquire(scope, key);

    public WorkspaceLockHolderRecord? ReadHolder(string canonicalRoot) => WorkspaceFileLock.ReadHolder(canonicalRoot);
}
