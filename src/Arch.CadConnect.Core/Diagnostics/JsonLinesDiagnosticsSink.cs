using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Diagnostics;

/// <summary>M4.2 retention limits: a file rolls over at
///  <see cref="MaxFileBytes"/>; the oldest log files are deleted so there are
///  never more than <see cref="MaxFiles"/> files or <see cref="MaxTotalBytes"/>
///  bytes in the log folder (counting room for the file being written) -
///  except files another writer still owns, which are never deleted.</summary>
public sealed record DiagnosticsRetention(long MaxFileBytes, int MaxFiles, long MaxTotalBytes)
{
    public static readonly DiagnosticsRetention Default = new(1L * 1024 * 1024, 50, 20L * 1024 * 1024);
}

/// <summary>
/// M4.2: writes each attempt to its own local JSON Lines file -
/// <c>&lt;startUtc&gt;_&lt;operation&gt;_&lt;attemptId&gt;[_pN].jsonl</c> - one
/// event per line, flushed per event (started, terminal and cleanup events to
/// disk at once). Only allow-listed, sanitized fields are written; dropped
/// fields are counted, never written.
///
/// CROSS-PROCESS SAFETY (several Inventor instances may share the folder):
/// <list type="bullet">
/// <item>OWNERSHIP - while an attempt is active its file is held open with
///  read-only sharing and NO delete sharing, so the operating system refuses
///  any other writer's (or process's) attempt to delete it. The handle is
///  released when the attempt ends - or by the OS if the process dies.</item>
/// <item>SERIALIZATION - creating a file and the retention pass that precedes
///  it run under a named, per-folder, cross-process mutex, so two processes
///  never count and delete concurrently.</item>
/// </list>
/// Retention only ever deletes files whose names match this writer's own
/// pattern, in its own folder, and skips any file it cannot delete.
/// BEST-EFFORT: <see cref="Write"/> never throws - a full disk, a missing or
/// read-only folder, a locked file all just increment <see cref="FailureCount"/>.
/// </summary>
public sealed partial class JsonLinesDiagnosticsSink : IDiagnosticsSink, IDisposable
{
    /// <summary>More concurrently active attempts than this in one process
    ///  is a leak (an attempt that never ended); the oldest handle is then
    ///  released (the file stays, and is reopened if written again).</summary>
    public const int MaxOpenFiles = 32;

    private static readonly TimeSpan RetentionLockTimeout = TimeSpan.FromSeconds(2);

    private readonly object _gate = new();
    private readonly string _directory;
    private readonly DiagnosticsRetention _retention;
    private readonly string? _userProfile;
    private readonly Mutex? _retentionLock;
    private readonly Dictionary<string, OwnedFile> _open = new(StringComparer.Ordinal);
    private long _openOrder;
    private int _failures;

    private sealed class OwnedFile
    {
        public required string Path { get; init; }
        public required int Part { get; init; }
        public FileStream? Stream { get; set; }
        public long OpenedOrder { get; set; }
    }

    [GeneratedRegex(@"^\d{8}T\d{6}Z_[a-z0-9.\-]{1,40}_[0-9a-f]{32}(_p\d{1,4})?\.jsonl$")]
    private static partial Regex OwnFileName();

    [GeneratedRegex(@"[^a-z0-9.\-]")]
    private static partial Regex UnsafeOperationChars();

    public JsonLinesDiagnosticsSink(string directory, DiagnosticsRetention? retention = null, string? userProfile = null)
    {
        _directory = directory;
        _retention = retention ?? DiagnosticsRetention.Default;
        _userProfile = userProfile ?? SafeUserProfile();
        try
        {
            _retentionLock = new Mutex(initiallyOwned: false, RetentionLockName(directory));
        }
        catch
        {
            _retentionLock = null;   // no lock -> retention is skipped, never unsafe
        }
    }

    /// <summary>The default folder: <c>%LOCALAPPDATA%\ArchEngineering\CadConnect\logs</c>.</summary>
    public static string DefaultDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArchEngineering", "CadConnect", "logs");

    /// <summary>The per-folder cross-process retention lock (per user session).</summary>
    public static string RetentionLockName(string directory)
    {
        var full = Path.GetFullPath(directory).TrimEnd('\\', '/').ToUpperInvariant();
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(full)))[..24];
        return @"Local\ArchCadConnect.DiagnosticsRetention." + hash;
    }

    public string Directory => _directory;

    /// <summary>How many events could not be written (never thrown).</summary>
    public int FailureCount => Volatile.Read(ref _failures);

    public static bool IsOwnLogFileName(string fileName) => OwnFileName().IsMatch(fileName);

    public void Write(DiagnosticEvent diagnosticEvent)
    {
        try
        {
            var line = Serialize(diagnosticEvent);
            lock (_gate)
            {
                System.IO.Directory.CreateDirectory(_directory);
                var owned = StreamFor(diagnosticEvent, line.Length);
                owned.Stream!.Write(line);
                owned.Stream.Flush(flushToDisk: diagnosticEvent.IsImportant);
                if (diagnosticEvent.Outcome is DiagnosticOutcome.Succeeded or DiagnosticOutcome.Failed or DiagnosticOutcome.Refused)
                {
                    // The attempt is over: give up ownership - the file may now
                    // be rotated away like any other.
                    Release(diagnosticEvent.AttemptId);
                }
            }
        }
        catch
        {
            Interlocked.Increment(ref _failures);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var id in _open.Keys.ToArray()) Release(id);
        }
        _retentionLock?.Dispose();
    }

    private OwnedFile StreamFor(DiagnosticEvent e, int lineBytes)
    {
        if (_open.TryGetValue(e.AttemptId, out var current))
        {
            current.Stream ??= OpenOwned(current.Path);
            current.OpenedOrder = ++_openOrder;
            if (current.Stream.Length + lineBytes <= _retention.MaxFileBytes)
            {
                return current;
            }
            Release(e.AttemptId);
            return Create(e, current.Part + 1);
        }
        return Create(e, 1);
    }

    /// <summary>Retention and creation of the new file happen together under
    ///  the cross-process lock.</summary>
    private OwnedFile Create(DiagnosticEvent e, int part)
    {
        var path = BuildPath(e, part);
        var locked = false;
        try
        {
            try
            {
                locked = _retentionLock?.WaitOne(RetentionLockTimeout) ?? false;
            }
            catch (AbandonedMutexException)
            {
                locked = true;   // a process died holding it; we now own it
            }
            if (locked)
            {
                EnforceRetention(path);
            }
            var owned = new OwnedFile { Path = path, Part = part, Stream = OpenOwned(path), OpenedOrder = ++_openOrder };
            _open[e.AttemptId] = owned;
            ReleaseOldestBeyondLimit();
            return owned;
        }
        finally
        {
            if (locked) _retentionLock!.ReleaseMutex();
        }
    }

    /// <summary>Write access for us; READ sharing only for everyone else -
    ///  no write, no delete - so no other writer can remove a file we own.</summary>
    private static FileStream OpenOwned(string path) =>
        new(path, FileMode.Append, FileAccess.Write, FileShare.Read);

    private void Release(string attemptId)
    {
        if (_open.Remove(attemptId, out var owned))
        {
            try { owned.Stream?.Dispose(); } catch { /* best-effort */ }
        }
    }

    private void ReleaseOldestBeyondLimit()
    {
        var withHandles = _open.Where(kv => kv.Value.Stream is not null).ToList();
        if (withHandles.Count <= MaxOpenFiles) return;
        foreach (var (_, owned) in withHandles.OrderBy(kv => kv.Value.OpenedOrder).Take(withHandles.Count - MaxOpenFiles))
        {
            try { owned.Stream!.Dispose(); } catch { /* best-effort */ }
            owned.Stream = null;
        }
    }

    private string BuildPath(DiagnosticEvent e, int part)
    {
        var operation = UnsafeOperationChars().Replace((e.Operation ?? "op").ToLowerInvariant(), "-");
        if (operation.Length == 0) operation = "op";
        if (operation.Length > 40) operation = operation[..40];
        var attempt = Regex.IsMatch(e.AttemptId ?? "", "^[0-9a-f]{32}$") ? e.AttemptId! : Guid.NewGuid().ToString("N");
        var name = e.AttemptStartedUtc.UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture)
            + "_" + operation + "_" + attempt + (part > 1 ? "_p" + part.ToString(CultureInfo.InvariantCulture) : "") + ".jsonl";
        return Path.Combine(_directory, name);
    }

    /// <summary>Delete the OLDEST own log files until one more file fits
    ///  within the count limit and a full new file within the size limit.
    ///  A file this sink owns is skipped; a file another writer owns cannot
    ///  be deleted (the OS refuses) and is skipped too.</summary>
    private void EnforceRetention(string newPath)
    {
        var inUse = new HashSet<string>(_open.Values.Select(v => v.Path), StringComparer.OrdinalIgnoreCase) { newPath };
        var own = new DirectoryInfo(_directory).EnumerateFiles("*.jsonl")
            .Where(f => IsOwnLogFileName(f.Name))
            .OrderBy(f => f.Name, StringComparer.Ordinal)   // the name starts with the UTC start time
            .ToList();
        var count = own.Count;
        var total = own.Sum(f => f.Length);
        foreach (var file in own)
        {
            if (count + 1 <= _retention.MaxFiles && total + _retention.MaxFileBytes <= _retention.MaxTotalBytes)
            {
                break;
            }
            if (inUse.Contains(file.FullName))
            {
                continue;
            }
            try
            {
                var length = file.Length;
                file.Delete();
                count--;
                total -= length;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // owned by another writer (or otherwise locked) - never forced
            }
        }
    }

    private byte[] Serialize(DiagnosticEvent e)
    {
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteString("ts", e.TimestampUtc.UtcDateTime.ToString("O", CultureInfo.InvariantCulture));
            json.WriteString("op", e.Operation);
            json.WriteString("attempt", e.AttemptId);
            json.WriteNumber("seq", e.Sequence);
            json.WriteString("outcome", e.Outcome switch
            {
                DiagnosticOutcome.Started => "started",
                DiagnosticOutcome.Step => "step",
                DiagnosticOutcome.Succeeded => "succeeded",
                DiagnosticOutcome.Failed => "failed",
                DiagnosticOutcome.Refused => "refused",
                DiagnosticOutcome.Cleanup => "cleanup",
                _ => "unknown",
            });

            var dropped = 0;
            var written = new HashSet<string>(StringComparer.Ordinal);
            json.WriteStartObject("data");
            foreach (var field in e.Fields)
            {
                if (!DiagnosticFieldAllowList.IsAllowed(field) || !written.Add(field.Name))
                {
                    dropped++;
                    continue;
                }
                switch (DiagnosticValueSanitizer.Sanitize(field, _userProfile))
                {
                    case null: json.WriteNull(field.Name); break;
                    case string s: json.WriteString(field.Name, s); break;
                    case long n: json.WriteNumber(field.Name, n); break;
                    case bool b: json.WriteBoolean(field.Name, b); break;
                }
            }
            json.WriteEndObject();
            if (dropped > 0)
            {
                json.WriteNumber("droppedFields", dropped);
            }
            json.WriteEndObject();
        }
        buffer.WriteByte((byte)'\n');
        return buffer.ToArray();
    }

    private static string? SafeUserProfile()
    {
        try { return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); }
        catch { return null; }
    }
}
