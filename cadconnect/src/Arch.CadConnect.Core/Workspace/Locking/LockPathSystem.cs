using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Arch.CadConnect.Core.Workspace.Locking;

/// <summary>
/// One path, fully resolved. <see cref="Canonical"/> is the real path of the
/// nearest EXISTING component (every junction, subst, mapped drive, short
/// name and case difference resolved by the file system) plus the remaining,
/// not-yet-existing segments as given.
/// </summary>
public sealed record ResolvedPath(
    string Requested,
    string Canonical,
    bool Exists,
    bool IsDirectory,
    FileIdentity? Id,
    string ExistingAncestor,
    FileIdentity? AncestorId,
    PathLocality Locality,
    ShareExposure Sharing)
{
    public static ResolvedPath Unresolvable(string requested) =>
        new(requested, requested, false, false, null, "", null, PathLocality.Unresolvable, ShareExposure.Unknown);

    public bool IsResolved => Locality != PathLocality.Unresolvable;
}

/// <summary>
/// P6 M4.4: everything the lock planner reads from the file system - and
/// ONLY reads: resolving, classifying and probing never create, change or
/// delete anything (so a refused command leaves no artifact).
/// </summary>
public interface ILockPathSystem
{
    ResolvedPath Resolve(string path);

    /// <summary>Whether <paramref name="directory"/> holds
    ///  <c>.arch\workspace.json</c> - the only workspace marker - or an
    ///  interrupted one, which is still that workspace.</summary>
    bool HasManifest(string directory);

    WorkspaceBindingSnapshot ReadBinding(string workspaceRoot);
}

/// <summary>Path comparisons used by the planner - case-insensitive, like the
///  file systems it runs on.</summary>
public static class LockPaths
{
    public static bool AreSame(string a, string b) => string.Equals(Trim(a), Trim(b), StringComparison.OrdinalIgnoreCase);

    /// <summary>True when <paramref name="path"/> is <paramref name="root"/>
    ///  itself or lies inside it (never a sibling sharing a prefix).</summary>
    public static bool IsSameOrUnder(string path, string root)
    {
        var p = Trim(path);
        var r = Trim(root);
        if (string.Equals(p, r, StringComparison.OrdinalIgnoreCase)) return true;
        var prefix = r.EndsWith('\\') ? r : r + "\\";
        return p.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The ordering / identity key: upper-case invariant.</summary>
    public static string Key(string path) => Trim(path).ToUpperInvariant();

    public static string Trim(string path) => Path.TrimEndingDirectorySeparator(path);

    /// <summary>Where a workspace's W lock file lives: <c>&lt;root&gt;\.arch\locks\workspace.lock</c>.</summary>
    public static string WorkspaceLockFile(string root) => Path.Combine(root, ".arch", "locks", "workspace.lock");
}

/// <summary>The real <see cref="ILockPathSystem"/>: Win32 handle queries,
///  the drive type, the cloud-sync roots and this machine's published share
///  list. Opens handles for attribute reads only.</summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsLockPathSystem : ILockPathSystem
{
    public static readonly WindowsLockPathSystem Instance = new();

    private const string SharesKey = @"SYSTEM\CurrentControlSet\Services\LanmanServer\Shares";

    // FILE_ATTRIBUTE_RECALL_ON_OPEN | PINNED | UNPINNED | RECALL_ON_DATA_ACCESS
    private const uint CloudAttributes = 0x00040000 | 0x00080000 | 0x00100000 | 0x00400000;

    private static readonly string[] CloudRootVariables = { "OneDrive", "OneDriveCommercial", "OneDriveConsumer" };

    public ResolvedPath Resolve(string path)
    {
        if (!TryNormalize(path, out var full))
        {
            return ResolvedPath.Unresolvable(path ?? "");
        }

        var existing = full;
        var remainder = new Stack<string>();
        while (!Directory.Exists(existing) && !File.Exists(existing))
        {
            var parent = Path.GetDirectoryName(existing);
            if (parent is null || string.Equals(parent, existing, StringComparison.Ordinal))
            {
                return ResolvedPath.Unresolvable(full);
            }
            remainder.Push(Path.GetFileName(existing));
            existing = parent;
        }
        var existingIsDirectory = Directory.Exists(existing);
        if (remainder.Count > 0 && !existingIsDirectory)
        {
            return ResolvedPath.Unresolvable(full); // a path "inside" a file
        }
        if (!WindowsFileNative.TryQuery(existing, out var ancestorFinal, out var info))
        {
            return ResolvedPath.Unresolvable(full);
        }

        var canonical = remainder.Aggregate(ancestorFinal, Path.Combine);
        var ancestorId = new FileIdentity(info.VolumeSerial, info.FileIndex);
        var locality = ClassifyVolume(ancestorFinal);
        if (locality == PathLocality.Local && IsCloudSync(canonical, info.Attributes))
        {
            locality = PathLocality.CloudSync;
        }
        var sharing = locality == PathLocality.Local ? ShareExposureOf(canonical) : ShareExposure.Unknown;
        var exists = remainder.Count == 0;
        return new ResolvedPath(
            full,
            canonical,
            exists,
            exists && existingIsDirectory,
            exists ? ancestorId : null,
            ancestorFinal,
            ancestorId,
            locality,
            sharing);
    }

    public bool HasManifest(string directory)
    {
        try
        {
            return WorkspaceRecoveryState.Inspect(directory).Status != WorkspaceRecoveryStatus.New;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            return false;
        }
    }

    public WorkspaceBindingSnapshot ReadBinding(string workspaceRoot)
    {
        if (WorkspaceRecoveryState.Inspect(workspaceRoot).IsRecoveryRequired)
        {
            return WorkspaceBindingSnapshot.RecoveryRequired;
        }
        var path = Path.Combine(workspaceRoot, WorkspaceManifest.RelativeManifestPath);
        if (!File.Exists(path))
        {
            return WorkspaceBindingSnapshot.None;
        }
        try
        {
            using var json = JsonDocument.Parse(File.ReadAllText(path));
            var root = json.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return new WorkspaceBindingSnapshot(true, "[unreadable]", null, null);
            }
            return new WorkspaceBindingSnapshot(true, Text(root, "schema"), Text(root, "serverOrigin"), Text(root, "organizationId"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new WorkspaceBindingSnapshot(true, "[unreadable]", null, null);
        }
    }

    /// <summary>Strip a <c>\\?\</c> prefix, refuse device paths, resolve
    ///  <c>.</c> and <c>..</c>, drop a trailing separator.</summary>
    internal static bool TryNormalize(string? path, out string full)
    {
        full = "";
        if (string.IsNullOrWhiteSpace(path)) return false;
        var p = path.Trim();
        if (p.StartsWith(@"\\.\", StringComparison.Ordinal) || p.StartsWith(@"\\?\GLOBALROOT", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        p = StripLongPrefix(p);
        if (!Path.IsPathFullyQualified(p)) return false;
        try
        {
            full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(p));
            return true;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return false;
        }
    }

    internal static string StripLongPrefix(string path)
    {
        if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + path[8..];
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path[4..];
        return path;
    }

    private static PathLocality ClassifyVolume(string finalPath)
    {
        if (finalPath.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return PathLocality.Network;
        }
        try
        {
            var root = Path.GetPathRoot(finalPath);
            if (string.IsNullOrEmpty(root)) return PathLocality.Unresolvable;
            return new DriveInfo(root).DriveType switch
            {
                DriveType.Fixed or DriveType.Removable => PathLocality.Local,
                DriveType.Network => PathLocality.Network,
                _ => PathLocality.UnsupportedDrive,
            };
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or UnauthorizedAccessException)
        {
            return PathLocality.Unresolvable;
        }
    }

    private static bool IsCloudSync(string canonical, uint attributes)
    {
        if ((attributes & CloudAttributes) != 0) return true;
        foreach (var variable in CloudRootVariables)
        {
            var value = Environment.GetEnvironmentVariable(variable);
            if (string.IsNullOrWhiteSpace(value) || !TryNormalize(value, out var root)) continue;
            if (WindowsFileNative.TryQuery(root, out var rootFinal, out _)) root = rootFinal;
            if (LockPaths.IsSameOrUnder(canonical, root)) return true;
        }
        return false;
    }

    /// <summary>This machine's published shares (no admin rights needed to
    ///  read the list). Unreadable means <see cref="ShareExposure.Unknown"/>.</summary>
    private static ShareExposure ShareExposureOf(string canonical)
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(SharesKey);
            if (key is null) return ShareExposure.NotShared;
            foreach (var name in key.GetValueNames())
            {
                if (key.GetValue(name) is not string[] lines) continue;
                var line = lines.FirstOrDefault(l => l.StartsWith("Path=", StringComparison.OrdinalIgnoreCase));
                if (line is null || !TryNormalize(line[5..], out var sharePath)) continue;
                if (WindowsFileNative.TryQuery(sharePath, out var shareFinal, out _)) sharePath = shareFinal;
                if (LockPaths.IsSameOrUnder(canonical, sharePath)) return ShareExposure.Shared;
            }
            return ShareExposure.NotShared;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return ShareExposure.Unknown;
        }
    }

    private static string? Text(JsonElement root, string name) =>
        root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}

/// <summary>What one handle query returns.</summary>
internal readonly record struct NativeFileInfo(uint Attributes, uint VolumeSerial, ulong FileIndex, uint LinkCount)
{
    public const uint ReparsePoint = 0x400;
    public const uint Directory = 0x10;

    public bool IsReparsePoint => (Attributes & ReparsePoint) != 0;
}

/// <summary>The few Win32 calls M4.4 needs: open for attributes only, the
///  final (alias-free) path of a handle, and its volume / file identity.</summary>
[SupportedOSPlatform("windows")]
internal static class WindowsFileNative
{
    private const uint FileReadAttributes = 0x80;
    private const uint ShareAll = 0x1 | 0x2 | 0x4;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;

    /// <summary>Follows reparse points: the FINAL path and identity.</summary>
    public static bool TryQuery(string path, out string finalPath, out NativeFileInfo info) =>
        TryQuery(path, followReparse: true, out finalPath, out info);

    /// <summary>The attributes of <paramref name="path"/> ITSELF - a junction
    ///  or symbolic link reports itself, not its target.</summary>
    public static bool TryQueryLink(string path, out NativeFileInfo info) =>
        TryQuery(path, followReparse: false, out _, out info);

    public static bool TryQuery(SafeFileHandle handle, out string finalPath, out NativeFileInfo info)
    {
        finalPath = "";
        info = default;
        if (!GetFileInformationByHandle(handle, out var raw)) return false;
        info = new NativeFileInfo(raw.Attributes, raw.VolumeSerial, ((ulong)raw.IndexHigh << 32) | raw.IndexLow, raw.Links);
        var buffer = new char[512];
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
        if (length >= buffer.Length)
        {
            buffer = new char[length + 1];
            length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
        }
        if (length == 0 || length >= buffer.Length) return false;
        finalPath = Path.TrimEndingDirectorySeparator(WindowsLockPathSystem.StripLongPrefix(new string(buffer, 0, (int)length)));
        return true;
    }

    private static bool TryQuery(string path, bool followReparse, out string finalPath, out NativeFileInfo info)
    {
        finalPath = "";
        info = default;
        using var handle = CreateFileW(path, FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting,
            BackupSemantics | (followReparse ? 0 : OpenReparsePoint), IntPtr.Zero);
        return !handle.IsInvalid && TryQuery(handle, out finalPath, out info);
    }

    // FILETIME is two DWORDs: 4-byte packing keeps the native layout.
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct ByHandleFileInformation
    {
        public uint Attributes;
        public ulong CreationTime;
        public ulong LastAccessTime;
        public ulong LastWriteTime;
        public uint VolumeSerial;
        public uint SizeHigh;
        public uint SizeLow;
        public uint Links;
        public uint IndexHigh;
        public uint IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation information);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, [Out] char[] path, uint length, uint flags);
}
