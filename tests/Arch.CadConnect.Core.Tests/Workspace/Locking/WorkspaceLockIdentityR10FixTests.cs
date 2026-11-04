using System.Runtime.Versioning;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>Runs only on the branch Windows takes on this machine when a folder
///  holding a held workspace lock is renamed, and says so visibly otherwise: a
///  branch that did not run must not report a pass.</summary>
[SupportedOSPlatform("windows")]
public sealed class HeldRootRenameFactAttribute : FactAttribute
{
    private static readonly Lazy<bool> RenameRefused = new(Probe);

    public HeldRootRenameFactAttribute(bool whenRenameRefused)
    {
        if (RenameRefused.Value != whenRenameRefused)
        {
            Skip = whenRenameRefused
                ? "Windows on this machine lets a folder holding a held workspace lock be renamed, so the rename-refused branch did not run."
                : "Windows on this machine refuses to rename a folder holding a held workspace lock, so the rename-succeeds branch did not run.";
        }
    }

    private static bool Probe()
    {
        var root = Path.Combine(Path.GetTempPath(), "arch-m44-rename-probe-" + Guid.NewGuid().ToString("N"));
        var aside = root + "-aside";
        var held = WorkspaceFileLock.Acquire(root, LockMode.Exclusive, WorkspaceLockHolderRecord.ForCurrentProcess("probe", LockMode.Exclusive));
        try
        {
            Directory.Move(root, aside);
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return true;
        }
        finally
        {
            held.Handle?.Dispose();
            foreach (var dir in new[] { root, aside })
            {
                try { if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
            }
        }
    }
}

/// <summary>Wraps the scripted path system so one answer can be changed after the
///  locks are taken - an identity that cannot be read, a folder that is gone.</summary>
internal sealed class ScriptedPaths(FakeLockPathSystem inner) : ILockPathSystem
{
    public Func<string, ResolvedPath, ResolvedPath>? Override { get; set; }

    public ResolvedPath Resolve(string path)
    {
        var resolved = inner.Resolve(path);
        return Override is { } change ? change(path, resolved) : resolved;
    }

    public bool HasManifest(string directory) => inner.HasManifest(directory);

    public WorkspaceBindingSnapshot ReadBinding(string workspaceRoot) => inner.ReadBinding(workspaceRoot);
}

/// <summary>
/// P6 M4.4 Package C R10 NO-GO corrections (MAJOR 2 and the locking addenda): every
/// held workspace root is proved through its own held lock file, admission is one
/// gated step that only its taker ends, and every handle is released once, in
/// reverse, whatever throws. Test IDs follow the approved correction plan.
/// </summary>
[SupportedOSPlatform("windows")]
public class WorkspaceLockIdentityR10FixTests
{
    private const string Origin = "http://localhost:3100";
    private const string Ws = @"D:\WS";
    private const string Part = @"D:\WS\a.ipt";

    private static InvalidOperationException Refused(WorkspaceLockRefusal refusal) => new(refusal.ErrorCode);

    private static WorkspaceLockRequest Document() => WorkspaceLockRequest.ForDocument("Checkout", Part);

    private static FakeLockPathSystem OneWorkspace() => new FakeLockPathSystem().Workspace(Ws).File(Part);

    private static CommandLock Admit(ILockPathSystem fs, FakeLockHandleFactory factory, WorkspaceLockRequest request) =>
        new CommandLockGate(new WorkspaceLockAcquirer(fs, factory), null).Admit(request, () => true).Lock!;

    private static void AssertReleasedOnceInReverse(FakeLockHandleFactory factory) =>
        Assert.Equal(factory.Calls.AsEnumerable().Reverse(), factory.Released);

    private static WorkspaceLockAcquisition Acquire(ILockPathSystem fs, FakeLockHandleFactory factory, WorkspaceLockRequest request) =>
        new WorkspaceLockAcquirer(fs, factory).TryAcquire(request);

    private static void AssertRefusedAndReleased(WorkspaceLockAcquisition acquisition, FakeLockHandleFactory factory)
    {
        Assert.False(acquisition.Acquired);
        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, acquisition.Refusal!.ErrorCode);
        AssertReleasedOnceInReverse(factory);
    }

    // ---- L: identity capture -------------------------------------------------------

    [Fact]
    public void L1_a_held_lock_that_cannot_say_where_its_file_is_proves_nothing()
    {
        var factory = new FakeLockHandleFactory { FinalPathOf = (_, _) => null };

        AssertRefusedAndReleased(Acquire(OneWorkspace(), factory, Document()), factory);
    }

    [Fact]
    public void L2_a_held_lock_file_somewhere_else_proves_nothing()
    {
        var factory = new FakeLockHandleFactory { FinalPathOf = (_, _) => LockPaths.WorkspaceLockFile(@"D:\Other") };

        AssertRefusedAndReleased(Acquire(OneWorkspace(), factory, Document()), factory);
    }

    [Theory]
    [InlineData("no-identity")]
    [InlineData("unresolved")]
    public void L3_a_root_with_no_known_identity_proves_nothing(string how)
    {
        var paths = new ScriptedPaths(OneWorkspace());
        var factory = new FakeLockHandleFactory
        {
            // Only once the locks are held and revalidated: the capture's own read.
            OnFinalPath = (_, asked) =>
            {
                if (asked == 1)
                {
                    paths.Override = (path, resolved) => !LockPaths.AreSame(path, Ws) ? resolved
                        : how == "no-identity" ? resolved with { Id = null } : ResolvedPath.Unresolvable(path);
                }
            },
        };

        AssertRefusedAndReleased(Acquire(paths, factory, Document()), factory);
    }

    [Fact]
    public void L4_a_lock_file_whose_path_changes_between_the_two_reads_proves_nothing()
    {
        var factory = new FakeLockHandleFactory { FinalPathOf = (root, asked) => asked == 1 ? LockPaths.WorkspaceLockFile(root) : @"D:\Elsewhere\workspace.lock" };

        AssertRefusedAndReleased(Acquire(OneWorkspace(), factory, Document()), factory);
    }

    [Fact]
    public void L5_a_capture_that_throws_is_a_refusal_and_releases_everything()
    {
        var factory = new FakeLockHandleFactory();
        factory.ThrowOnFinalPath.Add(Ws);

        AssertRefusedAndReleased(Acquire(OneWorkspace(), factory, Document()), factory);
    }

    [Fact]
    public void L6_a_failing_close_is_counted_and_every_handle_is_closed_exactly_once()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory();
        factory.ThrowOnRelease.Add(@"W:Exclusive:D:\DestWS");
        var lease = Acquire(fs, factory, request).Lease!;

        lease.Dispose();
        lease.Dispose();

        AssertReleasedOnceInReverse(factory);
        Assert.Equal(1, lease.FailedReleases);
    }

    [Fact]
    public void L7_held_roots_are_recorded_once()
    {
        var lease = Acquire(OneWorkspace(), new FakeLockHandleFactory(), Document()).Lease!;

        Assert.Single(lease.HeldRoots);
        Assert.Throws<InvalidOperationException>(() => lease.SetHeldRoots(new Dictionary<string, FileIdentity>()));
        lease.Dispose();
    }

    [Fact]
    public async Task L8_a_self_acquired_root_replaced_before_the_operation_is_refused_and_released()
    {
        var fs = OneWorkspace();
        var factory = new FakeLockHandleFactory();
        var held = Admit(fs, factory, Document());
        held.BeforeAdmission = () => fs.Replace(Ws);
        var ran = false;

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(Document(), () =>
        {
            ran = true;
            return Task.FromResult(1);
        }, Refused));

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, ex.Message);
        Assert.False(ran);
        Assert.True(held.IsReleased);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public void L9_a_borrowed_root_replaced_is_refused_spends_the_admission_and_never_self_acquires()
    {
        var fs = OneWorkspace();
        var factory = new FakeLockHandleFactory();
        var held = Admit(fs, factory, Document());

        fs.Replace(Ws);

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(Document())!.ErrorCode);
        Assert.Equal("Spent", held.StageName);
        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(Document())!.ErrorCode);
        Assert.Single(factory.Calls);
        Assert.Empty(factory.Released);
        held.Release();
        AssertReleasedOnceInReverse(factory);
    }

    [HeldRootRenameFact(whenRenameRefused: true)]
    public void L10a_when_Windows_refuses_to_rename_a_held_new_root_the_command_runs_on_it_and_releases()
    {
        using var tree = new TempTree();
        var root = Path.Combine(tree.Root, "New");
        var aside = root + "-aside";
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);
        var renamed = (bool?)null;
        acquirer.AfterAcquire = () =>
        {
            try
            {
                Directory.Move(root, aside);
                renamed = true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                renamed = false;
            }
        };

        var acquisition = acquirer.TryAcquire(WorkspaceLockRequest.ForGetLatest("Get Latest", root));

        Assert.False(renamed);
        Assert.True(acquisition.Acquired, acquisition.Refusal?.ErrorCode);
        Assert.Single(acquisition.Lease!.HeldRoots);
        acquisition.Lease.Dispose();
        Assert.False(Directory.Exists(aside));
        Assert.Equal(new[] { @"D \New", @"D \New\.arch", @"D \New\.arch\locks" },
            tree.Snapshot().Where(s => s.StartsWith("D ", StringComparison.Ordinal)).ToArray());
        var again = acquirer.TryAcquire(WorkspaceLockRequest.ForGetLatest("Get Latest", root));
        Assert.True(again.Acquired, again.Refusal?.ErrorCode);
        again.Lease!.Dispose();
    }

    [HeldRootRenameFact(whenRenameRefused: false)]
    public void L10b_when_Windows_lets_a_held_new_root_be_renamed_and_replaced_the_command_is_refused_and_releases()
    {
        using var tree = new TempTree();
        var root = Path.Combine(tree.Root, "New");
        var aside = root + "-aside";
        var acquirer = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance)
        {
            AfterAcquire = () =>
            {
                Directory.Move(root, aside);
                Directory.CreateDirectory(root);
            },
        };

        var acquisition = acquirer.TryAcquire(WorkspaceLockRequest.ForGetLatest("Get Latest", root));

        Assert.False(acquisition.Acquired);
        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, acquisition.Refusal!.ErrorCode);
        Assert.Empty(Directory.EnumerateFileSystemEntries(root));
        var freed = WorkspaceFileLock.Acquire(aside, LockMode.Exclusive, WorkspaceLockHolderRecord.ForCurrentProcess("check", LockMode.Exclusive));
        Assert.True(freed.Held, freed.ErrorCode);
        freed.Handle!.Dispose();
    }

    [Fact]
    public async Task L11_an_existing_root_is_proved_and_admitted_self_acquired_and_borrowed()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var request = WorkspaceLockRequest.ForDocument("Checkout", tree.File(@"WS\a.ipt"));

        var self = await WorkspaceCommandScope.RunAsync(request, () => { }, () => Task.FromResult(1), Refused);
        Assert.Equal(1, self);

        var held = new CommandLockGate(new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), null)
            .Admit(request, () => true).Lock!;
        Assert.Single(held.Lease.HeldRoots);
        var borrowed = 0;
        await held.RunAsync(async _ => borrowed = await WorkspaceCommandScope.RunAsync(request, () => { }, () => Task.FromResult(2), Refused), CancellationToken.None);
        Assert.Equal(2, borrowed);
        Assert.True(held.IsReleased);
    }

    [Fact]
    public void L12_an_exception_on_the_third_of_four_locks_releases_the_first_two_in_reverse()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory { ThrowOnAcquireKey = @"D:\DestWS" };

        Assert.Throws<IOException>(() => Acquire(fs, factory, request));

        Assert.Equal(new[] { @"Destination:D:\OUT", "Operation:http://localhost:3100|key-1" }, factory.Released);
    }

    [Fact]
    public void L13_a_root_renamed_aside_and_replaced_between_the_two_reads_is_refused()
    {
        var fs = OneWorkspace();
        var factory = new FakeLockHandleFactory
        {
            OnFinalPath = (root, asked) =>
            {
                if (asked == 1) fs.Replace(root);
            },
            FinalPathOf = (root, asked) => asked == 1 ? LockPaths.WorkspaceLockFile(root) : LockPaths.WorkspaceLockFile(root + "-aside"),
        };

        AssertRefusedAndReleased(Acquire(fs, factory, Document()), factory);
    }

    [Fact]
    public void L14_the_same_path_with_a_different_root_identity_is_refused()
    {
        var fs = OneWorkspace();
        var factory = new FakeLockHandleFactory
        {
            OnFinalPath = (root, asked) =>
            {
                if (asked == 1) fs.Replace(root);
            },
        };

        AssertRefusedAndReleased(Acquire(fs, factory, Document()), factory);
    }

    [Fact]
    public void L15_a_root_replaced_after_its_capture_is_refused_when_proved_again()
    {
        var fs = OneWorkspace();
        var factory = new FakeLockHandleFactory();
        var held = Admit(fs, factory, Document());
        Assert.Single(held.Lease.HeldRoots);

        fs.Replace(Ws);

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(Document())!.ErrorCode);
        Assert.Empty(factory.Released);
        held.Release();
        AssertReleasedOnceInReverse(factory);
    }

    // ---- I: identity rules and exception-safe cleanup ------------------------------

    [Fact]
    public void I1_an_existing_root_whose_identity_differs_from_planning_is_refused()
    {
        var paths = new ScriptedPaths(OneWorkspace());
        var factory = new FakeLockHandleFactory
        {
            OnFinalPath = (_, asked) =>
            {
                if (asked == 1)
                {
                    paths.Override = (path, resolved) => LockPaths.AreSame(path, Ws) ? resolved with { Id = new FileIdentity(7, 999_999) } : resolved;
                }
            },
        };

        AssertRefusedAndReleased(Acquire(paths, factory, Document()), factory);
    }

    [Theory]
    [InlineData("not-a-folder")]
    [InlineData("gone")]
    public void I2_a_root_that_is_not_an_existing_folder_at_capture_is_refused(string how)
    {
        var paths = new ScriptedPaths(OneWorkspace());
        var factory = new FakeLockHandleFactory
        {
            OnFinalPath = (_, asked) =>
            {
                if (asked == 1)
                {
                    paths.Override = (path, resolved) => !LockPaths.AreSame(path, Ws) ? resolved
                        : how == "gone" ? resolved with { Exists = false, IsDirectory = false } : resolved with { IsDirectory = false };
                }
            },
        };

        AssertRefusedAndReleased(Acquire(paths, factory, Document()), factory);
    }

    /// <summary>Three workspace roots (two shared sources, one exclusive
    ///  destination) and the operation lock: O, W1, W2, W3 in acquisition order.</summary>
    private static (FakeLockPathSystem Fs, WorkspaceLockRequest Request) ThreeWorkspaces()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\W1").Workspace(@"D:\W2").Workspace(@"D:\W3")
            .File(@"D:\W1\a.ipt").File(@"D:\W3\c.ipt");
        return (fs, WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-3",
            new[] { @"D:\W1\a.ipt", @"D:\W3\c.ipt" }, new[] { @"D:\W2\b2.ipt" }));
    }

    private static readonly string[] ThreeWorkspaceReleaseOrder =
    {
        @"W:Shared:D:\W3", @"W:Exclusive:D:\W2", @"W:Shared:D:\W1", "Operation:http://localhost:3100|key-3",
    };

    [Fact]
    public void I3_a_capture_failing_on_workspace_target_2_of_3_releases_all_of_them_3_2_1()
    {
        var (fs, request) = ThreeWorkspaces();
        var factory = new FakeLockHandleFactory { FinalPathOf = (root, _) => LockPaths.AreSame(root, @"D:\W2") ? null : LockPaths.WorkspaceLockFile(root) };

        var acquisition = Acquire(fs, factory, request);

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, acquisition.Refusal!.ErrorCode);
        Assert.Equal(new[] { "Operation:http://localhost:3100|key-3", @"W:Shared:D:\W1", @"W:Exclusive:D:\W2", @"W:Shared:D:\W3" }, factory.Calls);
        Assert.Equal(ThreeWorkspaceReleaseOrder, factory.Released);
    }

    [Fact]
    public void I4_a_close_that_throws_never_stops_the_rest_and_each_handle_is_closed_once()
    {
        var (fs, request) = ThreeWorkspaces();
        var factory = new FakeLockHandleFactory { FinalPathOf = (root, _) => LockPaths.AreSame(root, @"D:\W2") ? null : LockPaths.WorkspaceLockFile(root) };
        factory.ThrowOnRelease.Add(@"W:Exclusive:D:\W2");

        var acquisition = Acquire(fs, factory, request);

        Assert.False(acquisition.Acquired);
        Assert.Equal(ThreeWorkspaceReleaseOrder, factory.Released);
    }

    // R10 MINOR correction: the earlier "I4 when proving again" test used a Copy Design
    // request, which has no target path and is refused by Verify BEFORE any root is
    // proved again - so it never exercised re-proof. Re-proof is only reachable for the
    // operations that are self-admitted (a document command or Get Latest), and those
    // hold exactly one workspace root. The two tests below therefore cover, separately
    // and honestly: (a) a re-proof that really runs and fails, with its failing close
    // counted; (b) a three-root lease released with one failing close, counted, each
    // handle once, in reverse. (c) pins the Copy Design behaviour Codex found.

    [Fact]
    public async Task I4b_a_failed_re_proof_before_a_self_acquired_operation_releases_its_handle_once_and_counts_the_failed_close()
    {
        var factory = new FakeLockHandleFactory();
        factory.ThrowOnRelease.Add(@"W:Exclusive:D:\WS");
        var held = Admit(OneWorkspace(), factory, Document());
        var asked = 0;
        factory.OnFinalPath = (_, n) => asked = n;
        // Proved at capture (queries 1 and 2); the re-proof's first query (3) fails.
        factory.FinalPathOf = (root, n) => n >= 3 ? null : LockPaths.WorkspaceLockFile(root);
        var ran = false;

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(Document(), () => { ran = true; return Task.FromResult(1); }, Refused));

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, ex.Message);
        Assert.Equal(3, asked);   // the re-proof really ran, and stopped at its failing query
        Assert.False(ran);
        Assert.Equal(new[] { @"W:Exclusive:D:\WS" }, factory.Released);
        Assert.Equal(1, held.Lease.FailedReleases);
        held.Release();
        held.Lease.Dispose();
        held.Dispose();
        Assert.Equal(new[] { @"W:Exclusive:D:\WS" }, factory.Released);
    }

    [Fact]
    public void I4c_a_three_root_lease_released_with_one_failing_close_counts_it_and_closes_each_handle_once_3_2_1()
    {
        var (fs, request) = ThreeWorkspaces();
        var factory = new FakeLockHandleFactory();
        factory.ThrowOnRelease.Add(@"W:Exclusive:D:\W2");
        var held = Admit(fs, factory, request);

        held.Release();
        held.Lease.Dispose();
        held.Dispose();

        Assert.Equal(ThreeWorkspaceReleaseOrder, factory.Released);
        Assert.Equal(1, held.Lease.FailedReleases);
    }

    [Fact]
    public async Task I4d_a_Copy_Design_lock_is_never_self_admitted_and_is_refused_before_any_root_is_proved_again()
    {
        var (fs, request) = ThreeWorkspaces();
        var factory = new FakeLockHandleFactory();
        var held = Admit(fs, factory, request);
        var asked = 0;
        factory.OnFinalPath = (_, _) => asked++;

        await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(request, () => Task.FromResult(1), Refused));

        Assert.Equal(0, asked);
        Assert.Equal(ThreeWorkspaceReleaseOrder, factory.Released);
    }

    // ---- the refusal's words ----------------------------------------------------------

    [Fact]
    public void The_scope_refusal_names_all_three_causes_keeps_its_code_and_says_nothing_happened()
    {
        Assert.Equal("lock-scope-refused", WorkspaceLockErrorCodes.LockScopeRefused);

        var text = WorkspaceLockMessages.Describe(new WorkspaceLockRefusal(WorkspaceLockErrorCodes.LockScopeRefused, Path: @"D:\WS"));

        Assert.Contains(@"(""D:\WS"")", text);
        Assert.Contains("taken for a different operation", text);
        Assert.Contains("has already ended", text);
        Assert.Contains("could not be verified as the one that was locked", text);
        Assert.Contains("Nothing was sent to the server and nothing was changed.", text);
        Assert.DoesNotContain("is not the one its command", text);
    }

    [Fact]
    public void An_unprovable_Copy_Design_root_is_refused_with_words_that_fit_it()
    {
        var factory = new FakeLockHandleFactory { FinalPathOf = (_, _) => null };
        var (fs, request) = CopyDesignScenario();

        var refusal = Acquire(fs, factory, request).Refusal!;

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, refusal.ErrorCode);
        Assert.Contains("could not be verified", WorkspaceLockMessages.Describe(refusal));
    }

    [Fact]
    public void I5_a_guard_that_throws_under_the_lock_releases_every_handle_once()
    {
        var factory = new FakeLockHandleFactory();
        var calls = 0;

        Assert.Throws<InvalidDataException>(() => new CommandLockGate(new WorkspaceLockAcquirer(OneWorkspace(), factory), null)
            .Admit(Document(), () => ++calls == 1 ? true : throw new InvalidDataException("guard")));

        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task I5_an_operation_that_throws_releases_every_handle_once_and_its_exception_surfaces()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());

        await Assert.ThrowsAsync<InvalidDataException>(() => held.RunAdmittedAsync<int>(Document(), () => throw new InvalidDataException("operation"), Refused));

        Assert.True(held.IsReleased);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task I5_restoring_the_ambient_scope_that_throws_still_releases_every_handle_once()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        held.AfterAmbientRestored = () => throw new InvalidDataException("restore");

        await Assert.ThrowsAsync<InvalidDataException>(() => held.RunAdmittedAsync(Document(), () => Task.FromResult(1), Refused));

        Assert.True(held.IsReleased);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task I5_a_refusal_factory_that_throws_still_releases_every_handle_once()
    {
        var fs = OneWorkspace();
        var factory = new FakeLockHandleFactory();
        var held = Admit(fs, factory, Document());
        held.BeforeAdmission = () => fs.Replace(Ws);

        await Assert.ThrowsAsync<InvalidDataException>(() => held.RunAdmittedAsync(Document(), () => Task.FromResult(1),
            _ => throw new InvalidDataException("factory")));

        Assert.True(held.IsReleased);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task I5_a_proof_that_throws_is_a_refusal_and_releases_every_handle_once()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        factory.ThrowOnFinalPath.Add(Ws);

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(Document(), () => Task.FromResult(1), Refused));

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, ex.Message);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task I6_a_release_while_the_root_is_proved_again_waits_for_the_operation()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        // Capture asked twice; the proof before the operation asks a third time.
        factory.OnFinalPath = (_, asked) =>
        {
            if (asked == 3) held.Release();
        };
        var duringOperation = new List<string>();

        await held.RunAdmittedAsync(Document(), () =>
        {
            duringOperation.AddRange(factory.Released);
            duringOperation.Add(held.StageName);
            return Task.FromResult(1);
        }, Refused);

        Assert.Equal(new[] { "Closing" }, duringOperation);
        Assert.True(held.IsReleased);
        AssertReleasedOnceInReverse(factory);
    }

    // ---- A: admission is one gated step --------------------------------------------

    [Fact]
    public async Task A1_a_release_that_wins_before_self_admission_refuses_it_untouched()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        held.BeforeAdmission = held.Release;
        var ran = false;

        await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(Document(), () => { ran = true; return Task.FromResult(1); }, Refused));

        Assert.False(ran);
        Assert.Equal("Released", held.StageName);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task A2_a_lease_disposal_that_wins_before_self_admission_refuses_it_untouched()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        held.BeforeAdmission = held.Lease.Dispose;
        var ran = false;

        await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(Document(), () => { ran = true; return Task.FromResult(1); }, Refused));

        Assert.False(ran);
        Assert.Equal("Released", held.StageName);
        AssertReleasedOnceInReverse(factory);
    }

    [Theory]
    [InlineData("release")]
    [InlineData("dispose")]
    public async Task A3_A4_a_release_after_admission_waits_for_the_operation_to_end(string how)
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        var during = new List<string>();

        await held.RunAdmittedAsync(Document(), () =>
        {
            if (how == "release") held.Release(); else held.Lease.Dispose();
            during.Add(held.StageName);
            during.Add(factory.Released.Count.ToString());
            return Task.FromResult(1);
        }, Refused);

        Assert.Equal(new[] { "Closing", "0" }, during);
        Assert.Equal("Released", held.StageName);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task A5_no_admission_is_possible_from_Spent_Closing_or_Released()
    {
        // Spent
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        Assert.Null(held.TryBorrow(Document()));
        held.EndAdmission();
        Assert.Equal("Spent", held.StageName);
        await AssertNoAdmission(held, "Spent");
        held.Release();

        // Closing
        factory = new FakeLockHandleFactory();
        held = Admit(OneWorkspace(), factory, Document());
        Assert.Null(held.TryBorrow(Document()));
        held.Release();
        Assert.Equal("Closing", held.StageName);
        await AssertNoAdmission(held, "Closing");
        Assert.Empty(factory.Released);
        held.EndAdmission();
        AssertReleasedOnceInReverse(factory);

        // Released
        Assert.Equal("Released", held.StageName);
        await AssertNoAdmission(held, "Released");
        AssertReleasedOnceInReverse(factory);
    }

    private static async Task AssertNoAdmission(CommandLock held, string stage)
    {
        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, held.TryBorrow(Document())!.ErrorCode);
        var ran = false;
        await Assert.ThrowsAsync<InvalidOperationException>(() => held.RunAdmittedAsync(Document(), () => { ran = true; return Task.FromResult(1); }, Refused));
        Assert.False(ran);
        Assert.Equal(stage, held.StageName);
    }

    // ---- B: only the taker of admission ends it ------------------------------------

    private static Task<int> Sibling(Func<WorkspaceLockRefusal, Exception> refused) =>
        WorkspaceCommandScope.RunAsync(Document(), () => { }, () => Task.FromResult(2), refused);

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task B1_to_B6_a_refused_sibling_never_ends_or_releases_the_operation_that_holds_admission(bool closing, bool factoryThrows)
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        var stageBefore = "";
        var stageAfter = "";
        Exception? sibling = null;
        var releasedDuring = -1;

        await held.RunAsync(async _ => await WorkspaceCommandScope.RunAsync(Document(), () => { }, async () =>
        {
            if (closing) held.Release();
            stageBefore = held.StageName;
            sibling = await Record.ExceptionAsync(() => Task.Run(() => Sibling(factoryThrows
                ? _ => throw new InvalidDataException("sibling factory")
                : Refused)));
            stageAfter = held.StageName;
            releasedDuring = factory.Released.Count;
            return 1;
        }, Refused), CancellationToken.None);

        Assert.Equal(closing ? "Closing" : "Active", stageBefore);
        Assert.Equal(stageBefore, stageAfter);
        Assert.Equal(0, releasedDuring);
        if (factoryThrows)
        {
            Assert.IsType<InvalidDataException>(sibling);
        }
        else
        {
            Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, Assert.IsType<InvalidOperationException>(sibling).Message);
        }
        // B3 / B6: the original ends and its handles are released exactly once.
        Assert.Equal("Released", held.StageName);
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public async Task B7_a_sibling_trying_the_self_acquired_admission_on_an_active_command_is_refused_without_cleanup()
    {
        var factory = new FakeLockHandleFactory();
        var held = Admit(OneWorkspace(), factory, Document());
        var siblingRan = false;
        Exception? sibling = null;
        var during = "";

        await held.RunAsync(async _ => await WorkspaceCommandScope.RunAsync(Document(), () => { }, async () =>
        {
            sibling = await Record.ExceptionAsync(() => held.RunAdmittedAsync(Document(), () => { siblingRan = true; return Task.FromResult(2); },
                _ => throw new InvalidDataException("sibling factory")));
            during = held.StageName + "/" + factory.Released.Count;
            return 1;
        }, Refused), CancellationToken.None);

        Assert.IsType<InvalidDataException>(sibling);
        Assert.False(siblingRan);
        Assert.Equal("Active/0", during);
        AssertReleasedOnceInReverse(factory);
    }

    // ---- X: a process that dies holding a proved lock -------------------------------

    private static bool CanLockFromOutside(WorkspaceLockRequest request)
    {
        var attempt = new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance).TryAcquire(request);
        attempt.Lease?.Dispose();
        return attempt.Acquired;
    }

    [Fact]
    public async Task X2_a_child_killed_while_holding_a_self_acquired_proved_lock_frees_it_and_the_next_run_proves_its_root()
    {
        using var tree = new TempTree();
        tree.Workspace("WS", Origin);
        var part = tree.File(@"WS\a.ipt");
        var request = WorkspaceLockRequest.ForDocument("Checkout", part);
        using var probe = LockProbeProcess.Start("self-doc", part);

        Assert.Equal("HELD 1", probe.ReadLine());
        Assert.False(CanLockFromOutside(request));

        probe.Kill();

        Assert.True(Eventually.True(() => CanLockFromOutside(request)), "the OS did not release the dead process's lock");
        var proved = -1;
        await WorkspaceCommandScope.RunAsync(request, () => { }, () =>
        {
            proved = WorkspaceCommandScope.Current!.Lease.HeldRoots.Count;
            return Task.FromResult(1);
        }, Refused);
        Assert.Equal(1, proved);
    }

    // ---- CD: Copy Design keeps its locking ------------------------------------------

    private static (FakeLockPathSystem Fs, WorkspaceLockRequest Request) CopyDesignScenario()
    {
        var fs = new FakeLockPathSystem()
            .Workspace(@"D:\Src").File(@"D:\Src\a.ipt").Workspace(@"D:\DestWS").Dir(@"D:\Out");
        return (fs, WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-1",
            new[] { @"D:\Src\a.ipt" }, new[] { @"D:\Out\a2.ipt", @"D:\DestWS\b2.ipt" }));
    }

    [Fact]
    public void CD1_a_plan_with_no_workspace_is_admitted_with_no_root_to_prove()
    {
        var fs = new FakeLockPathSystem().File(@"D:\Loose\a.ipt").Dir(@"D:\Out");
        var factory = new FakeLockHandleFactory();
        var asked = 0;
        factory.OnFinalPath = (_, _) => asked++;
        var request = WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-m", new[] { @"D:\Loose\a.ipt" }, new[] { @"D:\Out\a2.ipt" });

        var held = new CommandLockGate(new WorkspaceLockAcquirer(fs, factory), null).Admit(request, () => true).Lock!;

        Assert.All(held.Lease.Targets, t => Assert.NotEqual(LockScope.Workspace, t.Scope));
        Assert.Empty(held.Lease.HeldRoots);
        Assert.Equal(0, asked);
        held.Release();
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public void CD2_a_shared_source_and_an_exclusive_destination_are_both_proved_with_their_modes_unchanged()
    {
        var (fs, request) = CopyDesignScenario();
        var factory = new FakeLockHandleFactory();

        var lease = Acquire(fs, factory, request).Lease!;

        Assert.Equal(new[] { "Operation:http://localhost:3100|key-1", @"Destination:D:\OUT", @"W:Exclusive:D:\DestWS", @"W:Shared:D:\Src" }, factory.Calls);
        Assert.Equal(new[] { @"D:\DestWS", @"D:\Src" }, lease.HeldRoots.Keys.OrderBy(k => k, StringComparer.Ordinal));
        lease.Dispose();
        AssertReleasedOnceInReverse(factory);
    }

    [Fact]
    public void CD3_a_source_root_that_is_also_a_destination_is_one_exclusive_target_proved_once()
    {
        var fs = new FakeLockPathSystem().Workspace(@"D:\WS").File(@"D:\WS\a.ipt");
        var factory = new FakeLockHandleFactory();
        var asked = 0;
        factory.OnFinalPath = (_, _) => asked++;
        var request = WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-p", new[] { @"D:\WS\a.ipt" }, new[] { @"D:\WS\a2.ipt" });

        var lease = Acquire(fs, factory, request).Lease!;

        Assert.Equal(new[] { "Operation:http://localhost:3100|key-p", @"W:Exclusive:D:\WS" }, factory.Calls);
        Assert.Single(lease.HeldRoots);
        Assert.Equal(2, asked);
        lease.Dispose();
    }

    /// <summary>O, D, the shared source (ASrc) and the exclusive destination
    ///  (BDest), acquired in that order.</summary>
    private static (FakeLockPathSystem Fs, WorkspaceLockRequest Request) SourceBeforeDestination()
    {
        var fs = new FakeLockPathSystem()
            .Workspace(@"D:\ASrc").File(@"D:\ASrc\a.ipt").Workspace(@"D:\BDest").Dir(@"D:\Out");
        return (fs, WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "key-4",
            new[] { @"D:\ASrc\a.ipt" }, new[] { @"D:\Out\a2.ipt", @"D:\BDest\b2.ipt" }));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void CD4_CD4b_a_later_workspace_capture_failure_releases_every_earlier_workspace_and_machine_handle(bool sourceCloseThrows)
    {
        var (fs, request) = SourceBeforeDestination();
        var factory = new FakeLockHandleFactory { FinalPathOf = (root, _) => LockPaths.AreSame(root, @"D:\BDest") ? null : LockPaths.WorkspaceLockFile(root) };
        if (sourceCloseThrows) factory.ThrowOnRelease.Add(@"W:Shared:D:\ASrc");

        var acquisition = Acquire(fs, factory, request);

        Assert.Equal(WorkspaceLockErrorCodes.LockScopeRefused, acquisition.Refusal!.ErrorCode);
        Assert.Equal(new[] { "Operation:http://localhost:3100|key-4", @"Destination:D:\OUT", @"W:Shared:D:\ASrc", @"W:Exclusive:D:\BDest" }, factory.Calls);
        Assert.Equal(new[] { @"W:Exclusive:D:\BDest", @"W:Shared:D:\ASrc", @"Destination:D:\OUT", "Operation:http://localhost:3100|key-4" }, factory.Released);
    }

    [Fact]
    public void CD6_a_real_Copy_Design_plan_keeps_shared_and_exclusive_behaviour_and_frees_everything()
    {
        using var tree = new TempTree();
        var src = tree.Workspace("Src", Origin);
        var part = tree.File(@"Src\a.ipt");
        var dest = tree.Workspace("Dest", Origin);
        var request = WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", Origin, "cd6-" + Guid.NewGuid().ToString("N"),
            new[] { part }, new[] { Path.Combine(dest, "a2.ipt") });
        var srcKey = WindowsLockPathSystem.Instance.Resolve(src).Canonical;
        var destKey = WindowsLockPathSystem.Instance.Resolve(dest).Canonical;

        var admission = new CommandLockGate(new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), null)
            .Admit(request, () => true);

        Assert.True(admission.Lock is not null, admission.LockRefusal?.ErrorCode);
        var held = admission.Lock!;
        Assert.Equal(2, held.Lease.HeldRoots.Count);
        Assert.Equal(LockMode.Shared, held.Lease.Targets.Single(t => t.Key == srcKey).Mode);
        Assert.Equal(LockMode.Exclusive, held.Lease.Targets.Single(t => t.Key == destKey).Mode);
        var operationKey = held.Lease.Targets.Single(t => t.Scope == LockScope.Operation).Key;

        var sharedToo = WorkspaceFileLock.Acquire(srcKey, LockMode.Shared, WorkspaceLockHolderRecord.ForCurrentProcess("probe", LockMode.Shared));
        Assert.True(sharedToo.Held, sharedToo.ErrorCode);
        sharedToo.Handle!.Dispose();
        Assert.Equal(WorkspaceLockErrorCodes.WorkspaceLocked,
            WorkspaceFileLock.Acquire(srcKey, LockMode.Exclusive, WorkspaceLockHolderRecord.ForCurrentProcess("probe", LockMode.Exclusive)).ErrorCode);
        Assert.False(MachineNamedLock.Acquire(LockScope.Operation, operationKey).Held);

        held.Release();

        foreach (var root in new[] { srcKey, destKey })
        {
            var freed = WorkspaceFileLock.Acquire(root, LockMode.Exclusive, WorkspaceLockHolderRecord.ForCurrentProcess("probe", LockMode.Exclusive));
            Assert.True(freed.Held, freed.ErrorCode);
            freed.Handle!.Dispose();
        }
        var operation = MachineNamedLock.Acquire(LockScope.Operation, operationKey);
        Assert.True(operation.Held, operation.ErrorCode);
        operation.Handle!.Dispose();
    }
}
