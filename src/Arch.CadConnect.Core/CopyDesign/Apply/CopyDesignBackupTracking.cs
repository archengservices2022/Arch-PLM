using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.CopyDesign.Apply;

/// <summary>
/// P6 Milestone 3: ownership-safe tracking of Inventor's "Old Versions"
/// backups created by Copy Design's own saves.
///
/// FACTS (measured on throwaway copies, Inventor 2027, OldVersionsToKeep = 1):
///  - EVERY save that overwrites an existing file - the metadata normalizer's
///    <c>Save2(false)</c>, the IAM rewirer's save, the drawing rewirer's
///    <c>Save2(false)</c> - first moves the PREVIOUS file into
///    <c>&lt;folder&gt;\OldVersions\&lt;stem&gt;.NNNN&lt;ext&gt;</c>, BYTE-IDENTICAL to the
///    file as it was immediately before the save (same SHA-256, original
///    timestamp kept). The physical copier's Save Copy As onto a NEW temp path
///    creates no backup.
///  - NNNN comes from the document's own save count, NOT from the folder: a
///    copy of a file saved once before produces <c>.0002</c>. A new backup can
///    therefore land on a name that already exists.
///  - Rotation keeps only the newest N backups PER NAME (stem + extension):
///    the second save of the same file DELETES the earlier backup - which
///    would destroy a HISTORICAL backup that happens to share the name.
///
/// OWNERSHIP PROOF: a backup is attributed to the current attempt ONLY when it
/// (1) is in the destination's own OldVersions folder, (2) matches
/// <c>&lt;destination stem&gt;.NNNN&lt;destination ext&gt;</c> exactly, (3) did NOT exist in
/// the snapshot taken immediately before this attempt's own save, and (4) is
/// byte-identical (SHA-256) to the destination as it was immediately before
/// that save. Anything else that appears, changes or disappears is a
/// PROBLEM - never silently claimed, never silently ignored.
/// </summary>
public sealed record CopyDesignBackupFile(string AbsolutePath, string FileName, long Length, string Sha256);

/// <summary>The state captured immediately before ONE attempt-owned save.</summary>
public sealed record CopyDesignBackupSnapshot(
    string DestinationAbsolutePath,
    string PreSaveDestinationSha256,
    IReadOnlyList<CopyDesignBackupFile> Backups);

/// <summary>File-system seam (real: <see cref="CopyDesignBackupFileSystem"/>;
///  tests: an in-memory fake).</summary>
public interface ICopyDesignBackupFileSystem
{
    /// <summary>Every file in <paramref name="destinationAbsolutePath"/>'s
    ///  OldVersions folder that <see cref="CopyDesignBackupNaming.IsBackupOf"/>
    ///  attributes to that destination's NAME, each with its SHA-256. Empty
    ///  when the folder does not exist. Throws when it cannot be read.</summary>
    IReadOnlyList<CopyDesignBackupFile> ListBackupsOf(string destinationAbsolutePath);

    string ComputeSha256(string absolutePath);

    bool FileExists(string absolutePath);

    /// <summary>Deletes ONE file. Never a directory.</summary>
    void DeleteFile(string absolutePath);
}

public static class CopyDesignBackupNaming
{
    public const string OldVersionsFolderName = "OldVersions";

    public static string OldVersionsFolderOf(string destinationAbsolutePath) =>
        Path.Combine(Path.GetDirectoryName(destinationAbsolutePath) ?? "", OldVersionsFolderName);

    /// <summary>True ONLY for <c>&lt;stem&gt;.NNNN&lt;ext&gt;</c> (four or more digits) of
    ///  EXACTLY this destination's stem and extension, case-insensitive -
    ///  never a merely similar name ("ARCH-TEST-0031", "ARCH-TEST-003-A",
    ///  another extension).</summary>
    public static bool IsBackupOf(string backupFileName, string destinationFileName)
    {
        ArgumentNullException.ThrowIfNull(backupFileName);
        ArgumentNullException.ThrowIfNull(destinationFileName);
        var stem = Path.GetFileNameWithoutExtension(destinationFileName);
        var extension = Path.GetExtension(destinationFileName);
        if (string.IsNullOrEmpty(stem) || string.IsNullOrEmpty(extension))
        {
            return false;
        }
        return Regex.IsMatch(backupFileName, $"^{Regex.Escape(stem)}\\.[0-9]{{4,}}{Regex.Escape(extension)}$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
}

/// <summary>The result of comparing the OldVersions state before and after
///  ONE attempt-owned save.</summary>
public sealed record CopyDesignBackupEvaluation(
    IReadOnlyList<CopyDesignBackupFile> NewlyOwned,
    IReadOnlyList<string> RotatedAwayOwnedPaths,
    IReadOnlyList<string> Problems)
{
    public bool Success => Problems.Count == 0;
}

public static class CopyDesignBackupOwnershipEvaluator
{
    /// <param name="alreadyOwnedPaths">Backups an EARLIER save of this SAME
    ///  attempt already proved it owns (e.g. the normalizer's backup, before
    ///  the IAM rewirer saves again) - the only pre-existing backups whose
    ///  disappearance (Inventor's rotation) is expected.</param>
    public static CopyDesignBackupEvaluation Evaluate(
        CopyDesignBackupSnapshot before, IReadOnlyList<CopyDesignBackupFile> after, IReadOnlyCollection<string> alreadyOwnedPaths)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(after);
        ArgumentNullException.ThrowIfNull(alreadyOwnedPaths);

        var owned = new HashSet<string>(alreadyOwnedPaths, StringComparer.OrdinalIgnoreCase);
        var beforeByName = before.Backups.ToDictionary(b => b.FileName, StringComparer.OrdinalIgnoreCase);
        var afterByName = after.ToDictionary(b => b.FileName, StringComparer.OrdinalIgnoreCase);
        var newlyOwned = new List<CopyDesignBackupFile>();
        var rotated = new List<string>();
        var problems = new List<string>();

        foreach (var file in after.OrderBy(f => f.FileName, StringComparer.OrdinalIgnoreCase))
        {
            if (beforeByName.ContainsKey(file.FileName))
            {
                continue;
            }
            if (string.Equals(file.Sha256, before.PreSaveDestinationSha256, StringComparison.OrdinalIgnoreCase))
            {
                newlyOwned.Add(file);
            }
            else
            {
                problems.Add($"A new backup \"{file.AbsolutePath}\" appeared during the save but its contents do not match "
                    + "the destination as it was before the save - ownership cannot be established; it was left untouched.");
            }
        }

        foreach (var previous in before.Backups.OrderBy(f => f.FileName, StringComparer.OrdinalIgnoreCase))
        {
            if (!afterByName.TryGetValue(previous.FileName, out var now))
            {
                if (owned.Contains(previous.AbsolutePath))
                {
                    rotated.Add(previous.AbsolutePath); // this attempt's own earlier backup, rotated away by Inventor
                }
                else
                {
                    problems.Add($"The pre-existing backup \"{previous.AbsolutePath}\" disappeared during the save "
                        + "(Inventor's backup rotation) - a backup not created by this attempt was affected.");
                }
            }
            else if (!string.Equals(now.Sha256, previous.Sha256, StringComparison.OrdinalIgnoreCase) || now.Length != previous.Length)
            {
                problems.Add($"The existing backup \"{previous.AbsolutePath}\" was changed during the save - ownership "
                    + "cannot be established; it was left untouched.");
            }
        }

        return new CopyDesignBackupEvaluation(newlyOwned, rotated, problems);
    }
}

/// <summary>ONE backup this attempt proved it owns (see the class doc of
///  <see cref="CopyDesignBackupFile"/>).</summary>
public sealed record CopyDesignOwnedBackup(string CadDocumentId, string AbsolutePath, string Sha256);

public static class CopyDesignBackupCleanup
{
    /// <summary>Deletes ONLY the owned backups in <paramref name="journal"/>,
    ///  newest first, each ONLY if it still exists with the EXACT recorded
    ///  SHA-256 (re-proving ownership at deletion time). A backup already gone
    ///  counts as cleaned. A changed backup, or one that cannot be deleted, is
    ///  left in place and reported. Never deletes a directory, never touches a
    ///  file the journal does not name.</summary>
    public static CopyDesignCleanupReport CleanUpOwnedBackups(CopyDesignExecutionJournal journal, ICopyDesignBackupFileSystem fileSystem)
    {
        ArgumentNullException.ThrowIfNull(journal);
        ArgumentNullException.ThrowIfNull(fileSystem);

        var outcomes = new List<CopyDesignCleanupOutcome>();
        foreach (var backup in journal.OwnedBackups.Reverse())
        {
            try
            {
                if (!fileSystem.FileExists(backup.AbsolutePath))
                {
                    outcomes.Add(new CopyDesignCleanupOutcome(backup.AbsolutePath, true, null));
                    continue;
                }
                if (!string.Equals(fileSystem.ComputeSha256(backup.AbsolutePath), backup.Sha256, StringComparison.OrdinalIgnoreCase))
                {
                    outcomes.Add(new CopyDesignCleanupOutcome(backup.AbsolutePath, false,
                        "its contents changed since this attempt created it - no longer provably owned, left in place"));
                    continue;
                }
                fileSystem.DeleteFile(backup.AbsolutePath);
                outcomes.Add(new CopyDesignCleanupOutcome(backup.AbsolutePath, true, null));
            }
            catch (Exception ex)
            {
                outcomes.Add(new CopyDesignCleanupOutcome(backup.AbsolutePath, false, ex.Message));
            }
        }
        journal.ClearOwnedBackups();
        return new CopyDesignCleanupReport(outcomes);
    }
}

/// <summary>The real <see cref="ICopyDesignBackupFileSystem"/> - plain file
///  I/O, no COM. Only ever enumerates ONE OldVersions folder, only ever
///  deletes ONE named file.</summary>
public sealed class CopyDesignBackupFileSystem : ICopyDesignBackupFileSystem
{
    public IReadOnlyList<CopyDesignBackupFile> ListBackupsOf(string destinationAbsolutePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationAbsolutePath);
        var folder = CopyDesignBackupNaming.OldVersionsFolderOf(destinationAbsolutePath);
        if (!Directory.Exists(folder))
        {
            return Array.Empty<CopyDesignBackupFile>();
        }
        var destinationName = Path.GetFileName(destinationAbsolutePath);
        return Directory.EnumerateFiles(folder)
            .Select(path => new FileInfo(path))
            .Where(info => CopyDesignBackupNaming.IsBackupOf(info.Name, destinationName))
            .OrderBy(info => info.Name, StringComparer.OrdinalIgnoreCase)
            .Select(info => new CopyDesignBackupFile(info.FullName, info.Name, info.Length, ComputeSha256(info.FullName)))
            .ToArray();
    }

    public string ComputeSha256(string absolutePath)
    {
        using var stream = new FileStream(absolutePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public bool FileExists(string absolutePath) => File.Exists(absolutePath);

    public void DeleteFile(string absolutePath) => File.Delete(absolutePath);
}
