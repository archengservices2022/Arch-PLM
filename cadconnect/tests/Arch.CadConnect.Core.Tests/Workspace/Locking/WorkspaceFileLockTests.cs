using System.Runtime.Versioning;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: the W primitive on real files in one process - the shared /
/// exclusive matrix (a second handle conflicts even inside the same
/// process), and the ARTIFACT RULES: only <c>.arch\locks\workspace.lock</c>
/// is ever created, existing data and the manifest are never touched, and a
/// link, hard link, foreign content or misplaced folder refuses with nothing
/// changed. Locks are never deleted.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WorkspaceFileLockTests : IDisposable
{
    private readonly TempTree _tree = new();

    public void Dispose() => _tree.Dispose();

    private static WorkspaceLockHolderRecord Holder(LockMode mode) => WorkspaceLockHolderRecord.ForCurrentProcess("test", mode);

    private static LockHandleResult Take(string root, LockMode mode) => WorkspaceFileLock.Acquire(root, mode, Holder(mode));

    private string Canonical(string path) => WindowsLockPathSystem.Instance.Resolve(path).Canonical;

    [Fact]
    public void Exclusive_creates_only_the_lock_file_and_leaves_the_manifest_byte_identical()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var manifest = Path.Combine(ws, WorkspaceManifest.RelativeManifestPath);
        var manifestHash = TempTree.Hash(manifest);
        var before = _tree.Snapshot();

        var held = Take(ws, LockMode.Exclusive);
        Assert.True(held.Held, held.ErrorCode);
        held.Handle!.Dispose();

        var added = _tree.Snapshot().Except(before).ToArray();
        Assert.Equal(2, added.Length);
        Assert.Contains(added, e => e == @"D \WS\.arch\locks");
        Assert.Contains(added, e => e.StartsWith(@"F \WS\.arch\locks\workspace.lock ", StringComparison.Ordinal));
        Assert.Empty(before.Except(_tree.Snapshot()).Where(e => !e.StartsWith(@"F \WS\.arch\locks", StringComparison.Ordinal)));
        Assert.Equal(manifestHash, TempTree.Hash(manifest));
    }

    [Fact]
    public void The_lock_file_is_never_deleted_and_the_next_holder_replaces_only_its_own_record()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        Take(ws, LockMode.Exclusive).Handle!.Dispose();
        var lockFile = WorkspaceFileLock.LockFilePath(ws);
        Assert.True(File.Exists(lockFile));

        var second = Take(ws, LockMode.Exclusive);
        Assert.True(second.Held);
        var record = WorkspaceFileLock.ReadHolder(ws);
        second.Handle!.Dispose();

        Assert.True(File.Exists(lockFile));
        Assert.Equal(WorkspaceLockHolderRecord.SchemaId, record!.Schema);
        Assert.Equal(Environment.ProcessId, record.ProcessId);
        Assert.Equal("exclusive", record.Mode);
    }

    [Fact]
    public void Exclusive_conflicts_with_exclusive_and_shared_even_inside_one_process()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var held = Take(ws, LockMode.Exclusive);

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, Take(ws, LockMode.Exclusive).ErrorCode);
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, Take(ws, LockMode.Shared).ErrorCode);

        held.Handle!.Dispose();
        var after = Take(ws, LockMode.Exclusive);
        Assert.True(after.Held);
        after.Handle!.Dispose();
    }

    [Fact]
    public void Shared_coexists_with_shared_and_blocks_exclusive_until_every_shared_holder_is_gone()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var one = Take(ws, LockMode.Shared);
        var two = Take(ws, LockMode.Shared);
        Assert.True(one.Held && two.Held);

        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, Take(ws, LockMode.Exclusive).ErrorCode);
        one.Handle!.Dispose();
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked, Take(ws, LockMode.Exclusive).ErrorCode);
        two.Handle!.Dispose();

        var exclusive = Take(ws, LockMode.Exclusive);
        Assert.True(exclusive.Held);
        exclusive.Handle!.Dispose();
    }

    [Fact]
    public void A_shared_holder_writes_no_record()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var shared = Take(ws, LockMode.Shared);

        Assert.Equal(0, new FileInfo(WorkspaceFileLock.LockFilePath(ws)).Length);
        shared.Handle!.Dispose();
    }

    [Fact]
    public void A_file_named_arch_refuses_and_is_left_unchanged()
    {
        var root = Canonical(_tree.Dir("WS"));
        var archFile = _tree.File(@"WS\.arch", "user data");
        var before = _tree.Snapshot();

        Assert.Equal(WorkspaceLockErrorCodes.LockPathInvalid, Take(root, LockMode.Exclusive).ErrorCode);
        Assert.Equal(before, _tree.Snapshot());
        Assert.Equal("user data", File.ReadAllText(archFile));
    }

    [Fact]
    public void An_arch_folder_that_is_a_junction_refuses_and_nothing_is_created_at_its_target()
    {
        var elsewhere = _tree.Dir("elsewhere");
        var root = Canonical(_tree.Dir("WS"));
        _tree.Junction(@"WS\.arch", elsewhere);
        var before = _tree.Snapshot();

        Assert.Equal(WorkspaceLockErrorCodes.LockPathReparse, Take(root, LockMode.Exclusive).ErrorCode);
        Assert.Equal(before, _tree.Snapshot());
        Assert.False(Directory.Exists(Path.Combine(elsewhere, "locks")));
    }

    [Fact]
    public void A_locks_folder_that_is_a_junction_refuses()
    {
        var elsewhere = _tree.Dir("elsewhere");
        var ws = Canonical(_tree.Workspace("WS"));
        _tree.Junction(@"WS\.arch\locks", elsewhere);

        Assert.Equal(WorkspaceLockErrorCodes.LockPathReparse, Take(ws, LockMode.Exclusive).ErrorCode);
        Assert.Empty(Directory.GetFileSystemEntries(elsewhere));
    }

    [Fact]
    public void A_folder_in_the_lock_file_s_place_refuses()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        _tree.Dir(@"WS\.arch\locks\workspace.lock");
        var before = _tree.Snapshot();

        Assert.Equal(WorkspaceLockErrorCodes.LockPathInvalid, Take(ws, LockMode.Exclusive).ErrorCode);
        Assert.Equal(before, _tree.Snapshot());
    }

    [Fact]
    public void A_lock_file_hard_linked_to_other_data_refuses_and_the_data_is_never_overwritten()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var manifest = Path.Combine(ws, WorkspaceManifest.RelativeManifestPath);
        var manifestHash = TempTree.Hash(manifest);
        Directory.CreateDirectory(Path.Combine(ws, ".arch", "locks"));
        NativeTestFile.CreateHardLink(WorkspaceFileLock.LockFilePath(ws), manifest);

        Assert.Equal(WorkspaceLockErrorCodes.LockPathInvalid, Take(ws, LockMode.Exclusive).ErrorCode);
        Assert.Equal(manifestHash, TempTree.Hash(manifest));
    }

    [Theory]
    [InlineData("not a lock record")]
    [InlineData("{\"schema\":\"someone-else.v1\"}")]
    public void Foreign_content_in_the_lock_file_refuses_and_is_left_unchanged(string content)
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var lockFile = _tree.File(@"WS\.arch\locks\workspace.lock", content);

        Assert.Equal(WorkspaceLockErrorCodes.LockForeignContent, Take(ws, LockMode.Exclusive).ErrorCode);
        Assert.Equal(WorkspaceLockErrorCodes.LockForeignContent, Take(ws, LockMode.Shared).ErrorCode);
        Assert.Equal(content, File.ReadAllText(lockFile));
    }

    [Fact]
    public void An_oversized_lock_file_refuses_and_is_left_unchanged()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var lockFile = _tree.File(@"WS\.arch\locks\workspace.lock", new string('x', WorkspaceLockHolderRecord.MaxBytes + 1));
        var hash = TempTree.Hash(lockFile);

        Assert.Equal(WorkspaceLockErrorCodes.LockForeignContent, Take(ws, LockMode.Exclusive).ErrorCode);
        Assert.Equal(hash, TempTree.Hash(lockFile));
    }

    [Fact]
    public void A_lock_file_this_user_may_not_open_fails_closed()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var lockFile = _tree.File(@"WS\.arch\locks\workspace.lock", "");
        var user = Environment.UserDomainName + "\\" + Environment.UserName;
        TempTree.Run("icacls.exe", lockFile, "/deny", user + ":(R,W)");
        try
        {
            Assert.Equal(WorkspaceLockErrorCodes.LockAccessDenied, Take(ws, LockMode.Exclusive).ErrorCode);
            Assert.Equal(WorkspaceLockErrorCodes.LockAccessDenied, Take(ws, LockMode.Shared).ErrorCode);
        }
        finally
        {
            TempTree.Run("icacls.exe", lockFile, "/remove:d", user);
        }
    }

    [Fact]
    public void The_holder_record_is_readable_while_held_and_names_a_live_process_on_this_machine()
    {
        var ws = Canonical(_tree.Workspace("WS"));
        var held = Take(ws, LockMode.Exclusive);

        var record = WorkspaceFileLock.ReadHolder(ws);
        Assert.NotNull(record);
        Assert.True(record!.IsLiveOnThisMachine());
        Assert.Equal("test", record.Command);
        Assert.Equal(Environment.MachineName, record.MachineName);
        held.Handle!.Dispose();
    }

    [Fact]
    public void A_record_from_another_machine_or_a_dead_process_is_not_live()
    {
        var mine = WorkspaceLockHolderRecord.ForCurrentProcess("test", LockMode.Exclusive);

        Assert.False((mine with { MachineName = "SOME-OTHER-PC" }).IsLiveOnThisMachine());
        Assert.False((mine with { ProcessStartedUtc = mine.ProcessStartedUtc!.Value.AddHours(-5) }).IsLiveOnThisMachine());
        Assert.False((mine with { ProcessId = int.MaxValue - 7 }).IsLiveOnThisMachine());
    }

    [Fact]
    public void A_holder_record_never_parses_from_bytes_that_are_not_ours()
    {
        Assert.Null(WorkspaceLockHolderRecord.TryParse(Array.Empty<byte>()));
        Assert.Null(WorkspaceLockHolderRecord.TryParse("{}"u8));
        Assert.Null(WorkspaceLockHolderRecord.TryParse("garbage"u8));
        var mine = WorkspaceLockHolderRecord.ForCurrentProcess("Get Latest", LockMode.Exclusive);
        Assert.Equal(mine, WorkspaceLockHolderRecord.TryParse(mine.Serialize()));
    }
}
