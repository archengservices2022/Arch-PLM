using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

using Arch.CadConnect.Core.Workspace.Locking;
using Microsoft.Win32.SafeHandles;

namespace Arch.CadConnect.Core.Workspace;

/// <summary>
/// P6 M4.4 Package C: the durable record of one stale-base replacement, written
/// BEFORE the original leaves its path and removed only once nothing is left to
/// recover, so a process killed part-way leaves a record a later Get Latest
/// finds. It holds identity and hashes only, never file content.
///
/// A record never authorizes deleting anything: it lives in the workspace, so
/// anyone able to edit <c>.arch</c> could forge it, the manifest and every hash
/// in them together. It can only ever put the file object it names back on an
/// empty path, and only when its own name, the copy's name and its operation id
/// agree, the copy is that object, and the manifest holds the checkout. A copy
/// goes only on evidence from outside the workspace: the live replacement
/// fetches the base version from the server and compares the bytes.
/// </summary>
public sealed partial record PendingReplacement
{
    public const string SchemaId = "arch-plm.pending-replacement.v1";

    [JsonPropertyName("schema")] public string Schema { get; init; } = "";
    [JsonPropertyName("operationId")] public string OperationId { get; init; } = "";
    [JsonPropertyName("relativePath")] public string RelativePath { get; init; } = "";
    [JsonPropertyName("cadDocumentId")] public string CadDocumentId { get; init; } = "";
    [JsonPropertyName("checkoutId")] public string CheckoutId { get; init; } = "";
    [JsonPropertyName("asideFileName")] public string AsideFileName { get; init; } = "";
    [JsonPropertyName("baseChecksum")] public string BaseChecksum { get; init; } = "";
    [JsonPropertyName("baseFileSize")] public long? BaseFileSize { get; init; }
    [JsonPropertyName("planChecksum")] public string PlanChecksum { get; init; } = "";
    [JsonPropertyName("planFileSize")] public long? PlanFileSize { get; init; }
    [JsonPropertyName("fileVolumeSerial")] public uint? FileVolumeSerial { get; init; }
    [JsonPropertyName("fileIndex")] public ulong? FileIndex { get; init; }

    [JsonIgnore]
    public FileIdentity? Identity => FileVolumeSerial is { } volume && FileIndex is { } index ? new FileIdentity(volume, index) : null;

    /// <summary>The copy's name for an operation on a file.</summary>
    public static string AsideNameFor(string fileName, string operationId) =>
        Path.GetFileNameWithoutExtension(fileName) + ".recovery-" + operationId + Path.GetExtension(fileName);

    /// <summary>Every field present and well formed, and the record's own file
    ///  name, the copy's name and the operation id all agreeing.</summary>
    public bool IsCompleteFor(string journalFileName) =>
        Schema == SchemaId
        && OperationIdFormat().IsMatch(OperationId)
        && !string.IsNullOrWhiteSpace(RelativePath)
        && WorkspaceManifest.IsWellFormedId(CadDocumentId)
        && WorkspaceManifest.IsWellFormedId(CheckoutId)
        && ChecksumFormat().IsMatch(BaseChecksum)
        && ChecksumFormat().IsMatch(PlanChecksum)
        && BaseFileSize >= 0
        && PlanFileSize >= 0
        && Identity is not null
        && string.Equals(AsideFileName, AsideNameFor(Path.GetFileName(RelativePath.Trim()), OperationId), StringComparison.OrdinalIgnoreCase)
        && string.Equals(journalFileName, AsideFileName + WorkspaceRecoveryFolder.JournalSuffix, StringComparison.OrdinalIgnoreCase);

    /// <summary>The manifest knows this operation: it still holds the checkout, or
    ///  the run that replaced the file also saved its result. Enough to report
    ///  the record as genuine; only the first may restore, and neither deletes.</summary>
    public bool IsVouchedForBy(WorkspaceManifestEntry? entry) =>
        entry is not null
        && string.Equals(entry.CadDocumentId, CadDocumentId, StringComparison.Ordinal)
        && (entry.Checkout is { } marker
            ? string.Equals(marker.CheckoutId, CheckoutId, StringComparison.Ordinal)
                && string.Equals(marker.BaseChecksum, BaseChecksum, StringComparison.Ordinal)
                && marker.BaseFileSize == BaseFileSize
            : string.Equals(entry.Checksum, PlanChecksum, StringComparison.Ordinal));

    [GeneratedRegex("^[0-9a-f]{32}$")]
    private static partial Regex OperationIdFormat();

    [GeneratedRegex("^[0-9a-fA-F]{64}$")]
    private static partial Regex ChecksumFormat();
}

/// <summary>
/// P6 M4.4 Package C: <c>.arch</c>, and optionally one folder inside it, proven to
/// be real folders inside the workspace and pinned there. Each level is opened
/// without following reparse points and without delete sharing, and proven before
/// anything is created inside it, so while this is held neither can be renamed
/// away or swapped for a junction. Anything that cannot be proven is refused:
/// <see cref="TryOpen"/> returns null.
/// </summary>
public sealed class PinnedWorkspaceFolder : IDisposable
{
    private readonly SafeFileHandle _arch;
    private readonly SafeFileHandle? _subfolder;

    private PinnedWorkspaceFolder(string path, SafeFileHandle arch, SafeFileHandle? subfolder)
    {
        Path = path;
        _arch = arch;
        _subfolder = subfolder;
    }

    /// <summary>The real path of the innermost folder.</summary>
    public string Path { get; }

    /// <summary>Whether anything exists at a path, by name alone: a link is an
    ///  existing thing even when its target is gone.</summary>
    public static bool ExistsByName(string path)
    {
        try
        {
            return File.GetAttributes(path) != 0;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ex is not (FileNotFoundException or DirectoryNotFoundException);
        }
    }

    /// <summary>Creates <c>.arch</c>, and is false if anything already has that
    ///  name: Windows answers both at once, so nothing can slip in between.</summary>
    public static bool TryCreateArch(string workspaceRoot) =>
        OperatingSystem.IsWindows() && PinnedFolder.CreateNew(System.IO.Path.Combine(workspaceRoot, ".arch"));

    /// <param name="subfolder">A folder inside <c>.arch</c>, or null for
    ///  <c>.arch</c> alone.</param>
    /// <param name="create">Create the folders first if they are missing.</param>
    public static PinnedWorkspaceFolder? TryOpen(string workspaceRoot, string? subfolder, bool create) =>
        TryOpen(workspaceRoot, subfolder, create, createDirectory: null);

    /// <param name="createDirectory">Replaces directory creation in tests.</param>
    internal static PinnedWorkspaceFolder? TryOpen(
        string workspaceRoot, string? subfolder, bool create, Action<string>? createDirectory)
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }
        try
        {
            return Open(workspaceRoot, subfolder, create, createDirectory ?? (path => Directory.CreateDirectory(path)));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    [SupportedOSPlatform("windows")]
    private static PinnedWorkspaceFolder? Open(string workspaceRoot, string? subfolder, bool create, Action<string> createDirectory)
    {
        if (!WindowsFileNative.TryQuery(workspaceRoot, out var rootFinal, out var rootInfo))
        {
            return null;
        }
        var archPath = System.IO.Path.Combine(workspaceRoot, ".arch");
        var archFinal = System.IO.Path.Combine(rootFinal, ".arch");

        SafeFileHandle? arch = null;
        SafeFileHandle? inner = null;
        var pinned = false;
        try
        {
            // Each level is proven and pinned BEFORE anything is created inside
            // it: creating first would write through a link to wherever it leads.
            arch = OpenCreatingIfMissing(archPath, create, createDirectory);
            if (!IsRealFolder(arch, archFinal, rootInfo))
            {
                return null;
            }
            if (subfolder is null)
            {
                pinned = true;
                return new PinnedWorkspaceFolder(archFinal, arch, null);
            }

            var innerFinal = System.IO.Path.Combine(archFinal, subfolder);
            inner = OpenCreatingIfMissing(System.IO.Path.Combine(archPath, subfolder), create, createDirectory);
            if (!IsRealFolder(inner, innerFinal, rootInfo))
            {
                return null;
            }
            pinned = true;
            return new PinnedWorkspaceFolder(innerFinal, arch, inner);
        }
        finally
        {
            if (!pinned)
            {
                inner?.Dispose();
                arch?.Dispose();
            }
        }
    }

    /// <summary>A link opens as itself, even a dangling one, so only a name with
    ///  nothing at all there is created.</summary>
    [SupportedOSPlatform("windows")]
    private static SafeFileHandle OpenCreatingIfMissing(string path, bool create, Action<string> createDirectory)
    {
        var folder = PinnedFolder.Open(path);
        if (folder.IsInvalid && create && Marshal.GetLastPInvokeError() == PinnedFolder.ErrorFileNotFound)
        {
            folder.Dispose();
            createDirectory(path);
            folder = PinnedFolder.Open(path);
        }
        return folder;
    }

    [SupportedOSPlatform("windows")]
    private static bool IsRealFolder(SafeFileHandle folder, string expected, NativeFileInfo root) =>
        !folder.IsInvalid
        && WindowsFileNative.TryQuery(folder, out var final, out var info)
        && !info.IsReparsePoint
        && (info.Attributes & NativeFileInfo.Directory) != 0
        && info.VolumeSerial == root.VolumeSerial
        && LockPaths.AreSame(final, expected);

    public void Dispose()
    {
        _subfolder?.Dispose();
        _arch.Dispose();
    }

    [SupportedOSPlatform("windows")]
    private static class PinnedFolder
    {
        // List access, not just attributes: an attributes-only handle takes no
        // part in share checks and would pin nothing.
        private const uint FileListDirectoryAndAttributes = 0x1 | 0x80;
        private const uint ShareReadWrite = 0x1 | 0x2;   // deliberately not delete
        private const uint OpenExisting = 3;
        private const uint BackupSemantics = 0x02000000;
        private const uint OpenReparsePoint = 0x00200000;

        public const int ErrorFileNotFound = 2;

        public static SafeFileHandle Open(string path) => CreateFileW(
            path, FileListDirectoryAndAttributes, ShareReadWrite, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);

        public static bool CreateNew(string path) => CreateDirectoryW(path, IntPtr.Zero);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateDirectoryW(string path, IntPtr securityAttributes);
    }
}

/// <summary>
/// P6 M4.4 Package C: one run's hold on the workspace's <c>.arch</c>, from the
/// first look at it through the manifest save, so everything the run reads and
/// writes there is in the same real folder. A folder that passes the location
/// and link checks is still not this run's folder: if <c>.arch</c> was there at
/// the start it is pinned at once, and if it was not, this run must be the one
/// that creates it. Disposing ends the hold, however the run ended.
/// </summary>
public sealed class ArchFolderLease : IDisposable
{
    private readonly string _root;
    private PinnedWorkspaceFolder? _arch;
    private bool _creationTried;

    private ArchFolderLease(string root, PinnedWorkspaceFolder? arch)
    {
        _root = root;
        _arch = arch;
    }

    /// <summary>Null if <c>.arch</c> exists but cannot be proven and pinned.</summary>
    public static ArchFolderLease? TryBegin(string workspaceRoot)
    {
        var root = Path.GetFullPath(workspaceRoot);
        if (!PinnedWorkspaceFolder.ExistsByName(Path.Combine(root, ".arch")))
        {
            return new ArchFolderLease(root, null);
        }
        return PinnedWorkspaceFolder.TryOpen(root, subfolder: null, create: false) is { } arch
            ? new ArchFolderLease(root, arch)
            : null;
    }

    /// <summary>Whether the folder is held, creating it if the run began without
    ///  one. False for good once something else got there first.</summary>
    public bool TryHold()
    {
        if (_arch is not null)
        {
            return true;
        }
        if (_creationTried)
        {
            return false;
        }
        _creationTried = true;
        try
        {
            Directory.CreateDirectory(_root);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
        if (!PinnedWorkspaceFolder.TryCreateArch(_root))
        {
            return false;
        }
        _arch = PinnedWorkspaceFolder.TryOpen(_root, subfolder: null, create: false);
        return _arch is not null;
    }

    public void Dispose() => _arch?.Dispose();
}

/// <summary>What is known about a recovery copy's path. Only
///  <see cref="Absent"/> lets its record go.</summary>
public enum RecoveryCopyPresence
{
    /// <summary>Windows answered that nothing has this name.</summary>
    Absent,

    /// <summary>Something has this name, file or not.</summary>
    Present,

    /// <summary>No answer: denied, busy, or anything else unexpected.</summary>
    Unknown,
}

/// <summary>P6 M4.4 Package C: <c>.arch\.recovery</c>, pinned, with the records
///  kept in it.</summary>
public sealed class WorkspaceRecoveryFolder : IDisposable
{
    public const string RelativePath = @".arch\.recovery";
    public const string JournalSuffix = ".pending.json";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly PinnedWorkspaceFolder _folder;

    private WorkspaceRecoveryFolder(PinnedWorkspaceFolder folder) => _folder = folder;

    /// <summary>The real path of the folder.</summary>
    public string Path => _folder.Path;

    /// <summary>Whether anything exists at the folder's path, by name alone.</summary>
    public static bool Exists(string workspaceRoot) =>
        PinnedWorkspaceFolder.ExistsByName(System.IO.Path.Combine(workspaceRoot, RelativePath));

    /// <param name="create">Create the folders first if they are missing.</param>
    public static WorkspaceRecoveryFolder? TryOpen(string workspaceRoot, bool create) =>
        Wrap(PinnedWorkspaceFolder.TryOpen(workspaceRoot, ".recovery", create));

    /// <param name="createDirectory">Replaces directory creation in tests.</param>
    internal static WorkspaceRecoveryFolder? TryOpen(string workspaceRoot, bool create, Action<string> createDirectory) =>
        Wrap(PinnedWorkspaceFolder.TryOpen(workspaceRoot, ".recovery", create, createDirectory));

    private static WorkspaceRecoveryFolder? Wrap(PinnedWorkspaceFolder? folder) =>
        folder is null ? null : new WorkspaceRecoveryFolder(folder);

    /// <summary>A missing folder is not a missing file: the recovery folder is
    ///  pinned when this is asked, so that too counts as no answer.</summary>
    public static RecoveryCopyPresence ProbeCopy(string path) => ProbeCopy(path, readAttributes: null);

    /// <param name="readAttributes">Replaces the attribute read in tests.</param>
    internal static RecoveryCopyPresence ProbeCopy(string path, Func<string, FileAttributes>? readAttributes)
    {
        try
        {
            _ = readAttributes is null ? File.GetAttributes(path) : readAttributes(path);
            return RecoveryCopyPresence.Present;
        }
        catch (FileNotFoundException)
        {
            return RecoveryCopyPresence.Absent;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return RecoveryCopyPresence.Unknown;
        }
    }

    /// <summary>The identity of the file object at a path, or null unless it is
    ///  a plain file with one name: a link would move as itself, and a hard link
    ///  leaves another name through which the bytes can change.</summary>
    public static FileIdentity? TryReadFileIdentity(string path)
    {
        if (!OperatingSystem.IsWindows()
            || !WindowsFileNative.TryQueryLink(path, out var info)
            || info.IsReparsePoint
            || (info.Attributes & NativeFileInfo.Directory) != 0
            || info.LinkCount != 1)
        {
            return null;
        }
        return new FileIdentity(info.VolumeSerial, info.FileIndex);
    }

    public string AsidePathFor(PendingReplacement pending) => System.IO.Path.Combine(Path, pending.AsideFileName);

    public string JournalPathFor(PendingReplacement pending) => AsidePathFor(pending) + JournalSuffix;

    /// <summary>Durable before it returns: flushed to disk, under a name that
    ///  cannot collide.</summary>
    public void WriteJournal(string journalPath, PendingReplacement pending)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(pending, Json);
        using var stream = new FileStream(journalPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        stream.Write(bytes);
        stream.Flush(flushToDisk: true);
    }

    /// <summary>
    /// Removes a record whose copy is gone. Seeing a name free proves nothing a
    /// moment later, so the name itself is taken: creating it fails if anything
    /// has it, which is the proof, and while this exclusive, empty placeholder is
    /// held nothing can create, move onto or replace that name. The placeholder
    /// goes when its handle closes, however the process ends. False means the
    /// name was not free or the record could not go: the record stays.
    /// </summary>
    public bool TryRemoveRecordOfAbsentCopy(string journalPath, string copyPath) =>
        TryRemoveRecordOfAbsentCopy(journalPath, copyPath, whileNameHeld: null);

    /// <param name="whileNameHeld">Test hook: runs with the name taken.</param>
    internal bool TryRemoveRecordOfAbsentCopy(string journalPath, string copyPath, Action<string>? whileNameHeld)
    {
        try
        {
            using var nameHeld = new FileStream(copyPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
            whileNameHeld?.Invoke(copyPath);
            File.Delete(journalPath);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    public IReadOnlyList<string> JournalPaths() => Directory.GetFiles(Path, "*" + JournalSuffix);

    /// <summary>The record, or null if it cannot be trusted as a record: see
    ///  <see cref="PendingReplacement.IsCompleteFor"/>, plus a target path that
    ///  must stay in the workspace.</summary>
    public PendingReplacement? TryReadJournal(string journalPath, string workspaceRoot)
    {
        try
        {
            var pending = JsonSerializer.Deserialize<PendingReplacement>(File.ReadAllBytes(journalPath), Json);
            if (pending is null || !pending.IsCompleteFor(System.IO.Path.GetFileName(journalPath)))
            {
                return null;
            }
            SafeWorkspacePath.ResolveWithinRoot(workspaceRoot, pending.RelativePath);
            return pending;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException
            or UnsafeWorkspacePathException or WorkspaceRootException)
        {
            return null;
        }
    }

    public void Dispose() => _folder.Dispose();
}

/// <summary>
/// P6 M4.4 Package C: one file object, held open from its hash to its last move.
/// The handle shares nothing, so while this is held nobody can write to, rename
/// or replace the file, and <see cref="TryRenameTo"/> and <see cref="TryDelete"/>
/// act through that same handle: on the object that was verified, never on
/// whatever a path names by then. If neither runs, the file simply stays.
/// </summary>
public sealed class PinnedRecoveryCopy : IDisposable
{
    private readonly FileStream _content;

    private PinnedRecoveryCopy(FileStream content, FileIdentity identity)
    {
        _content = content;
        Identity = identity;
    }

    public FileIdentity Identity { get; }

    /// <summary>The bytes, read through the pinned handle.</summary>
    public Stream Content => _content;

    /// <summary>Null unless the path is a plain file with one name that could be
    ///  held exclusively.</summary>
    public static PinnedRecoveryCopy? TryOpen(string path) => OperatingSystem.IsWindows() ? Open(path) : null;

    [SupportedOSPlatform("windows")]
    private static PinnedRecoveryCopy? Open(string path)
    {
        var handle = Native.Open(path);
        try
        {
            if (!handle.IsInvalid
                && WindowsFileNative.TryQuery(handle, out _, out var info)
                && !info.IsReparsePoint
                && (info.Attributes & NativeFileInfo.Directory) == 0
                && info.LinkCount == 1)
            {
                return new PinnedRecoveryCopy(new FileStream(handle, FileAccess.Read), new FileIdentity(info.VolumeSerial, info.FileIndex));
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException)
        {
            // Not held, so not pinned.
        }
        handle.Dispose();
        return null;
    }

    /// <summary>Marks this object for deletion; it goes when the handle closes.
    ///  False leaves the file as it is.</summary>
    public bool TryDelete() => OperatingSystem.IsWindows() && Native.MarkForDeletion(_content.SafeFileHandle);

    /// <summary>Moves this object to <paramref name="absolutePath"/>, which must
    ///  be free: an existing file there stays and this returns false, with the
    ///  object where it was.</summary>
    public bool TryRenameTo(string absolutePath) => OperatingSystem.IsWindows() && Native.Rename(_content.SafeFileHandle, absolutePath);

    public void Dispose() => _content.Dispose();

    [SupportedOSPlatform("windows")]
    private static class Native
    {
        private const uint GenericRead = 0x80000000;
        private const uint Delete = 0x00010000;
        private const uint ShareNone = 0;
        private const uint OpenExisting = 3;
        private const uint OpenReparsePoint = 0x00200000;
        private const int FileRenameInfo = 3;
        private const int FileDispositionInfoEx = 21;
        private const uint DispositionDelete = 0x1;
        private const uint DispositionIgnoreReadOnly = 0x10;

        public static SafeFileHandle Open(string path) =>
            CreateFileW(path, GenericRead | Delete, ShareNone, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero);

        public static bool MarkForDeletion(SafeFileHandle file)
        {
            var flags = DispositionDelete | DispositionIgnoreReadOnly;
            return SetFileInformationByHandle(file, FileDispositionInfoEx, ref flags, sizeof(uint));
        }

        /// <summary>FILE_RENAME_INFO with ReplaceIfExists false: a BOOLEAN, the
        ///  root-directory handle (none), the name's byte length, the name.</summary>
        public static bool Rename(SafeFileHandle file, string absolutePath)
        {
            var name = System.Text.Encoding.Unicode.GetBytes(@"\\?\" + Path.GetFullPath(absolutePath));
            var nameOffset = IntPtr.Size == 8 ? 20 : 12;
            var information = new byte[nameOffset + name.Length + sizeof(char)];
            BitConverter.TryWriteBytes(information.AsSpan(nameOffset - sizeof(int)), name.Length);
            name.CopyTo(information, nameOffset);
            return SetFileInformationByHandle(file, FileRenameInfo, information, (uint)information.Length);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, ref uint information, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int informationClass, byte[] information, uint size);
    }
}
