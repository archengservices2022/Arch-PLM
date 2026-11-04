namespace Arch.CadConnect.Core.Workspace;

public enum WorkspaceRecoveryStatus
{
    /// <summary>No manifest and nothing related to one: a new folder.</summary>
    New,

    /// <summary>A manifest file and nothing that casts doubt on it. Whether its
    ///  content can be read is for its reader to say.</summary>
    Healthy,

    /// <summary>Something related to the manifest is unexplained, or could not
    ///  be looked at. Neither new nor healthy: only a person can resolve it.</summary>
    RecoveryRequired,
}

/// <param name="Artifacts">Workspace-relative names, for the refusal to show.</param>
public sealed record WorkspaceRecoveryInspection(WorkspaceRecoveryStatus Status, IReadOnlyList<string> Artifacts)
{
    public bool IsRecoveryRequired => Status == WorkspaceRecoveryStatus.RecoveryRequired;
}

/// <summary>
/// P6 M4.4 Package C: the one read-only answer to "what state did the last
/// manifest save leave this workspace in?", used by admission, discovery and the
/// lock planner alike so that none of them can take an interrupted workspace for
/// a new or healthy one. It reads names and attributes and, only beside a
/// recognized temporary, the manifest; it changes nothing.
///
/// A file here proves nothing: this workspace folder is editable, so a name,
/// a timestamp or a hash in it is no evidence of what it holds. That is why
/// nothing found here is ever promoted, restored, moved or deleted, by any code.
/// An unexplained file can therefore only stop work until a person has looked;
/// see <c>docs\package-c-workspace-recovery.md</c>.
/// </summary>
public static class WorkspaceRecoveryState
{
    private const string ManifestName = "workspace.json";
    private const int OperationIdLength = 32;

    private static readonly WorkspaceRecoveryInspection New = new(WorkspaceRecoveryStatus.New, []);
    private static readonly WorkspaceRecoveryInspection Healthy = new(WorkspaceRecoveryStatus.Healthy, []);

    /// <summary>Exact names, compared as Windows does: never a wildcard, which
    ///  would match the manifest itself and depends on short names.</summary>
    private static readonly EnumerationOptions Everything = new()
    {
        AttributesToSkip = 0,
        IgnoreInaccessible = false,
        MatchType = MatchType.Simple,
        RecurseSubdirectories = false,
        ReturnSpecialDirectories = false,
    };

    /// <summary>Never throws: anything that could not be determined is
    ///  <see cref="WorkspaceRecoveryStatus.RecoveryRequired"/>.</summary>
    public static WorkspaceRecoveryInspection Inspect(string workspaceRoot)
    {
        var archName = ".arch";
        try
        {
            var root = Path.GetFullPath(workspaceRoot);
            var arch = Path.Combine(root, archName);
            if (!PinnedWorkspaceFolder.ExistsByName(arch))
            {
                return New;
            }
            var attributes = File.GetAttributes(arch);
            if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0)
            {
                return Required(archName);
            }
            return InspectFolder(root, new DirectoryInfo(arch));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return Required(archName);
        }
    }

    private static WorkspaceRecoveryInspection InspectFolder(string root, DirectoryInfo arch)
    {
        FileSystemInfo? manifest = null;
        var temporaries = new List<string>();
        var unexplained = new List<string>();

        foreach (var entry in arch.EnumerateFileSystemInfos("*", Everything))
        {
            if (!entry.Name.StartsWith(ManifestName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var relative = Path.Combine(arch.Name, entry.Name);
            if (entry.Name.Length == ManifestName.Length)
            {
                manifest = entry;
                if (!IsPlainFile(entry))
                {
                    unexplained.Add(relative);
                }
            }
            else if (IsRecognizedTemporary(entry))
            {
                temporaries.Add(relative);
            }
            else
            {
                unexplained.Add(relative);
            }
        }

        if (unexplained.Count > 0)
        {
            return new WorkspaceRecoveryInspection(WorkspaceRecoveryStatus.RecoveryRequired, [.. unexplained, .. temporaries]);
        }
        if (manifest is null)
        {
            return temporaries.Count == 0
                ? New
                : new WorkspaceRecoveryInspection(WorkspaceRecoveryStatus.RecoveryRequired, temporaries);
        }
        return temporaries.Count == 0 || IsValidManifest(root)
            ? Healthy
            : new WorkspaceRecoveryInspection(WorkspaceRecoveryStatus.RecoveryRequired, [.. temporaries, Path.Combine(arch.Name, ManifestName)]);
    }

    private static bool IsPlainFile(FileSystemInfo entry) =>
        (entry.Attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0;

    /// <summary>Exactly what a save writes: <c>workspace.json.&lt;32 hex&gt;.tmp</c>,
    ///  as a plain file. Any other shape is not ours to explain away.</summary>
    private static bool IsRecognizedTemporary(FileSystemInfo entry)
    {
        const string Suffix = ".tmp";
        var name = entry.Name;
        var expected = ManifestName.Length + 1 + OperationIdLength + Suffix.Length;
        return IsPlainFile(entry)
            && name.Length == expected
            && name[ManifestName.Length] == '.'
            && name.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)
            && name.AsSpan(ManifestName.Length + 1, OperationIdLength).IndexOfAnyExcept("0123456789abcdefABCDEF") < 0;
    }

    private static bool IsValidManifest(string root)
    {
        var (manifest, status) = WorkspaceManifest.Load(root);
        return status == WorkspaceManifestLoadStatus.Loaded && manifest.HasSoundEntries();
    }

    private static WorkspaceRecoveryInspection Required(string artifact) =>
        new(WorkspaceRecoveryStatus.RecoveryRequired, [artifact]);
}
