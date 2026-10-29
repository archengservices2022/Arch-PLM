using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 Milestone 3: the PURE ownership rules for Inventor OldVersions backups,
/// the hash-re-proven cleanup, and the real file-system adapter (against real
/// temporary folders - never CAD evidence).
/// </summary>
public class CopyDesignBackupTrackingTests
{
    private const string Dest = @"D:\dst\ARCH-TEST-003.ipt";
    private static readonly string Old = Path.Combine(@"D:\dst", "OldVersions");

    private static CopyDesignBackupFile B(string name, string sha) => new(Path.Combine(Old, name), name, sha.Length, sha);

    // ---- naming -------------------------------------------------------------

    [Theory]
    [InlineData("ARCH-TEST-003.0001.ipt", true)]
    [InlineData("ARCH-TEST-003.0002.ipt", true)]
    [InlineData("arch-test-003.0002.IPT", true)]   // case-insensitive, like NTFS
    [InlineData("ARCH-TEST-003.12345.ipt", true)]  // more than four digits
    [InlineData("ARCH-TEST-0031.0001.ipt", false)] // similar stem
    [InlineData("ARCH-TEST-003-A.0001.ipt", false)]
    [InlineData("XARCH-TEST-003.0001.ipt", false)]
    [InlineData("ARCH-TEST-003.0001.iam", false)]  // different extension (rotation is per extension)
    [InlineData("ARCH-TEST-003.001.ipt", false)]   // too few digits
    [InlineData("ARCH-TEST-003.0001.ipt.bak", false)]
    [InlineData("ARCH-TEST-003.ipt", false)]
    public void Only_the_exact_Inventor_backup_name_of_this_destination_matches(string candidate, bool expected)
    {
        Assert.Equal(expected, CopyDesignBackupNaming.IsBackupOf(candidate, "ARCH-TEST-003.ipt"));
    }

    [Fact]
    public void Regex_metacharacters_in_a_file_name_are_matched_literally()
    {
        Assert.True(CopyDesignBackupNaming.IsBackupOf("A+B (1).0002.ipt", "A+B (1).ipt"));
        Assert.False(CopyDesignBackupNaming.IsBackupOf("AAB (1).0002.ipt", "A+B (1).ipt"));
    }

    // ---- ownership evaluation --------------------------------------------------

    [Fact]
    public void No_OldVersions_folder_and_no_new_backup_means_nothing_owned_and_no_problem()
    {
        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "pre", Array.Empty<CopyDesignBackupFile>()), Array.Empty<CopyDesignBackupFile>(), Array.Empty<string>());

        Assert.True(result.Success);
        Assert.Empty(result.NewlyOwned);
    }

    [Fact]
    public void A_new_backup_byte_identical_to_the_pre_save_destination_is_owned()
    {
        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "pre-save-bytes", Array.Empty<CopyDesignBackupFile>()),
            new[] { B("ARCH-TEST-003.0002.ipt", "pre-save-bytes") }, Array.Empty<string>());

        Assert.True(result.Success);
        Assert.Equal("ARCH-TEST-003.0002.ipt", Assert.Single(result.NewlyOwned).FileName);
    }

    [Fact]
    public void A_new_backup_with_unexpected_contents_is_ambiguous_and_never_owned()
    {
        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "pre-save-bytes", Array.Empty<CopyDesignBackupFile>()),
            new[] { B("ARCH-TEST-003.0002.ipt", "someone-elses-bytes") }, Array.Empty<string>());

        Assert.False(result.Success);
        Assert.Empty(result.NewlyOwned);
        Assert.Contains("ownership cannot be established", Assert.Single(result.Problems), StringComparison.Ordinal);
    }

    [Fact]
    public void An_unchanged_historical_backup_is_preserved_and_never_claimed()
    {
        var historical = B("ARCH-TEST-003.0001.ipt", "history");

        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "history", new[] { historical }), new[] { historical }, Array.Empty<string>());

        Assert.True(result.Success);
        Assert.Empty(result.NewlyOwned); // same bytes as pre-save, but it EXISTED before - never claimed
    }

    [Fact]
    public void A_historical_backup_removed_by_rotation_is_a_problem()
    {
        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "pre", new[] { B("ARCH-TEST-003.0001.ipt", "history") }),
            new[] { B("ARCH-TEST-003.0002.ipt", "pre") }, Array.Empty<string>());

        Assert.False(result.Success);
        Assert.Contains(result.Problems, p => p.Contains("disappeared", StringComparison.Ordinal));
        Assert.Single(result.NewlyOwned); // the genuinely owned new one is still recognized, so cleanup can remove it
    }

    [Fact]
    public void This_attempts_own_earlier_backup_rotated_away_is_expected_not_a_problem()
    {
        var first = B("ARCH-TEST-003.0002.ipt", "v0");

        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "v1", new[] { first }), new[] { B("ARCH-TEST-003.0003.ipt", "v1") }, new[] { first.AbsolutePath });

        Assert.True(result.Success);
        Assert.Equal(new[] { first.AbsolutePath }, result.RotatedAwayOwnedPaths);
        Assert.Equal("ARCH-TEST-003.0003.ipt", Assert.Single(result.NewlyOwned).FileName);
    }

    [Fact]
    public void An_existing_backup_whose_contents_changed_is_a_problem()
    {
        var result = CopyDesignBackupOwnershipEvaluator.Evaluate(
            new CopyDesignBackupSnapshot(Dest, "pre", new[] { B("ARCH-TEST-003.0002.ipt", "history") }),
            new[] { B("ARCH-TEST-003.0002.ipt", "pre") }, Array.Empty<string>());

        Assert.False(result.Success);
        Assert.Empty(result.NewlyOwned);
        Assert.Contains(result.Problems, p => p.Contains("was changed", StringComparison.Ordinal));
    }

    // ---- cleanup ----------------------------------------------------------------

    private sealed class MemoryFs : ICopyDesignBackupFileSystem
    {
        public Dictionary<string, string> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Locked { get; } = new(StringComparer.OrdinalIgnoreCase);
        public IReadOnlyList<CopyDesignBackupFile> ListBackupsOf(string destinationAbsolutePath) => Array.Empty<CopyDesignBackupFile>();
        public string ComputeSha256(string absolutePath) => Files[absolutePath];
        public bool FileExists(string absolutePath) => Files.ContainsKey(absolutePath);
        public void DeleteFile(string absolutePath)
        {
            if (Locked.Contains(absolutePath)) throw new IOException("locked");
            Files.Remove(absolutePath);
        }
    }

    [Fact]
    public void Cleanup_deletes_only_journalled_backups_whose_hash_still_proves_ownership()
    {
        var fs = new MemoryFs();
        var journal = new CopyDesignExecutionJournal();
        var owned = B("ARCH-TEST-003.0002.ipt", "owned");
        var changed = B("ARCH-TEST-003.0003.ipt", "owned-then-changed");
        var gone = B("ARCH-TEST-003.0004.ipt", "already-gone");
        var locked = B("ARCH-TEST-003.0005.ipt", "locked");
        fs.Files[owned.AbsolutePath] = "owned";
        fs.Files[changed.AbsolutePath] = "tampered";
        fs.Files[locked.AbsolutePath] = "locked";
        fs.Locked.Add(locked.AbsolutePath);
        fs.Files[Path.Combine(Old, "ARCH-TEST-003.0001.ipt")] = "historical, not journalled";
        foreach (var b in new[] { owned, changed, gone, locked })
        {
            journal.RecordOwnedBackup("cad-1", b);
        }

        var report = CopyDesignBackupCleanup.CleanUpOwnedBackups(journal, fs);

        Assert.False(fs.FileExists(owned.AbsolutePath));
        Assert.True(fs.FileExists(changed.AbsolutePath));   // no longer provably owned
        Assert.True(fs.FileExists(locked.AbsolutePath));    // delete failed, reported
        Assert.True(fs.FileExists(Path.Combine(Old, "ARCH-TEST-003.0001.ipt"))); // never journalled, never touched
        Assert.True(report.Outcomes.Single(o => o.AbsolutePath == owned.AbsolutePath).Deleted);
        Assert.True(report.Outcomes.Single(o => o.AbsolutePath == gone.AbsolutePath).Deleted);
        Assert.Contains("no longer provably owned", report.Outcomes.Single(o => o.AbsolutePath == changed.AbsolutePath).FailureReason, StringComparison.Ordinal);
        Assert.Equal("locked", report.Outcomes.Single(o => o.AbsolutePath == locked.AbsolutePath).FailureReason);
        Assert.Empty(journal.OwnedBackups); // never retried twice by a later sweep
    }

    // ---- real file system (temporary folders only) ------------------------------

    [Fact]
    public void The_real_file_system_lists_only_exact_backups_hashes_them_and_never_deletes_a_folder()
    {
        var root = Path.Combine(Path.GetTempPath(), "arch-m3-backup-" + Guid.NewGuid().ToString("N"));
        try
        {
            var destination = Path.Combine(root, "ARCH-TEST-003.ipt");
            var fs = new CopyDesignBackupFileSystem();
            Directory.CreateDirectory(root);
            Assert.Empty(fs.ListBackupsOf(destination)); // no OldVersions folder at all

            var old = Path.Combine(root, "OldVersions");
            Directory.CreateDirectory(old);
            File.WriteAllText(Path.Combine(old, "ARCH-TEST-003.0002.ipt"), "backup bytes");
            File.WriteAllText(Path.Combine(old, "ARCH-TEST-0031.0001.ipt"), "similar");
            File.WriteAllText(Path.Combine(old, "ARCH-TEST-003.0001.iam"), "other extension");
            File.WriteAllText(destination, "backup bytes");

            var listed = fs.ListBackupsOf(destination);

            var only = Assert.Single(listed);
            Assert.Equal("ARCH-TEST-003.0002.ipt", only.FileName);
            Assert.Equal(fs.ComputeSha256(destination), only.Sha256);

            fs.DeleteFile(only.AbsolutePath);
            Assert.False(File.Exists(only.AbsolutePath));
            Assert.True(Directory.Exists(old)); // the folder itself is never removed
            Assert.True(File.Exists(Path.Combine(old, "ARCH-TEST-0031.0001.ipt")));
            Assert.True(File.Exists(Path.Combine(old, "ARCH-TEST-003.0001.iam")));
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
