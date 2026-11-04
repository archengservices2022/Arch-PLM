using System.Runtime.Versioning;
using Arch.CadConnect.Core.Workspace.Locking;
using Microsoft.Win32;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: the REAL path resolution on this Windows machine - every alias of
/// one folder resolves to the same canonical path and file identity, the
/// path classes fail closed, and resolving / probing never creates, changes
/// or deletes anything.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsLockPathSystemTests : IDisposable
{
    private readonly TempTree _tree = new();
    private readonly WindowsLockPathSystem _paths = WindowsLockPathSystem.Instance;

    public void Dispose() => _tree.Dispose();

    [Fact]
    public void Case_trailing_separators_dot_segments_and_the_long_path_prefix_resolve_to_one_folder()
    {
        var real = _tree.Dir(@"Work Space\Parts");
        var expected = _paths.Resolve(real);
        Assert.True(expected.Exists);
        Assert.True(expected.IsDirectory);
        Assert.Equal(PathLocality.Local, expected.Locality);

        foreach (var alias in new[]
        {
            real.ToUpperInvariant(),
            real + @"\",
            real + @"\\",
            Path.Combine(_tree.Root, @"Work Space\.\Parts"),
            Path.Combine(_tree.Root, @"Work Space\Other\..\Parts"),
            @"\\?\" + real,
        })
        {
            var resolved = _paths.Resolve(alias);
            Assert.True(LockPaths.AreSame(expected.Canonical, resolved.Canonical), alias + " -> " + resolved.Canonical);
            Assert.Equal(expected.Id, resolved.Id);
        }
    }

    [Fact]
    public void A_junction_resolves_to_its_target_folder_with_the_same_identity()
    {
        var target = _tree.Dir(@"real\WS");
        var link = _tree.Junction("link", Path.Combine(_tree.Root, "real"));

        var viaLink = _paths.Resolve(Path.Combine(link, "WS"));
        var direct = _paths.Resolve(target);

        Assert.True(LockPaths.AreSame(direct.Canonical, viaLink.Canonical), viaLink.Canonical);
        Assert.Equal(direct.Id, viaLink.Id);
        Assert.False(LockPaths.AreSame(viaLink.Requested, viaLink.Canonical));
    }

    [Fact]
    public void A_short_8_3_name_resolves_to_the_long_folder_when_the_volume_has_short_names()
    {
        var real = _tree.Dir("A Rather Long Folder Name");
        var shortForm = NativeTestFile.ShortPath(real);
        if (shortForm is null)
        {
            return; // 8.3 names are disabled on this volume - nothing to alias
        }

        Assert.True(LockPaths.AreSame(_paths.Resolve(real).Canonical, _paths.Resolve(shortForm).Canonical));
    }

    [Fact]
    public void A_path_that_does_not_exist_yet_is_its_real_existing_parent_plus_the_rest()
    {
        _tree.Dir("real");
        var link = _tree.Junction("link", Path.Combine(_tree.Root, "real"));

        var resolved = _paths.Resolve(Path.Combine(link, @"New\Deeper\a.ipt"));

        Assert.False(resolved.Exists);
        Assert.Null(resolved.Id);
        Assert.True(LockPaths.AreSame(_paths.Resolve(Path.Combine(_tree.Root, "real")).Canonical, resolved.ExistingAncestor));
        Assert.True(LockPaths.AreSame(Path.Combine(resolved.ExistingAncestor, @"New\Deeper\a.ipt"), resolved.Canonical));
    }

    [Theory]
    [InlineData("relative\\path")]
    [InlineData(@"\\.\C:")]
    [InlineData(@"\\?\GLOBALROOT\Device\HarddiskVolume1")]
    [InlineData("")]
    public void Relative_device_and_empty_paths_are_unresolvable(string path)
    {
        Assert.Equal(PathLocality.Unresolvable, _paths.Resolve(path).Locality);
    }

    [Fact]
    public void A_path_inside_a_file_is_unresolvable()
    {
        var file = _tree.File("a.ipt");

        Assert.Equal(PathLocality.Unresolvable, _paths.Resolve(Path.Combine(file, "child.ipt")).Locality);
    }

    [Theory]
    [InlineData(@"\\localhost\C$\Windows")]
    [InlineData(@"\\?\UNC\localhost\C$\Windows")]
    [InlineData(@"\\127.0.0.1\C$\Windows\x.ipt")]
    public void A_UNC_path_is_never_local_even_when_it_loops_back_to_this_machine(string path)
    {
        // Admin shares need elevation: either the path cannot be resolved, or
        // it resolves as Network - both fail closed.
        Assert.NotEqual(PathLocality.Local, _paths.Resolve(path).Locality);
    }

    [Fact]
    public void The_temp_folder_is_local()
    {
        Assert.Equal(PathLocality.Local, _paths.Resolve(_tree.Root).Locality);
    }

    [Fact]
    public void A_path_inside_the_OneDrive_folder_is_cloud_sync_when_this_user_has_one()
    {
        foreach (var variable in new[] { "OneDriveCommercial", "OneDrive", "OneDriveConsumer" })
        {
            var root = Environment.GetEnvironmentVariable(variable);
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) continue;

            Assert.Equal(PathLocality.CloudSync, _paths.Resolve(Path.Combine(root, @"never-created-m44\a.ipt")).Locality);
            Assert.False(Directory.Exists(Path.Combine(root, "never-created-m44")));
            return;
        }
    }

    [Fact]
    public void A_folder_this_machine_publishes_as_a_share_is_reported_shared()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\LanmanServer\Shares");
        var published = key?.GetValueNames()
            .Select(n => key.GetValue(n) as string[])
            .Select(lines => lines?.FirstOrDefault(l => l.StartsWith("Path=", StringComparison.OrdinalIgnoreCase))?[5..])
            .FirstOrDefault(p => p is not null && Directory.Exists(p));
        if (published is null)
        {
            return; // this machine publishes no folder shares
        }

        Assert.Equal(ShareExposure.Shared, _paths.Resolve(Path.Combine(published, @"never-created-m44\a.ipt")).Sharing);
        Assert.Equal(ShareExposure.NotShared, _paths.Resolve(_tree.Root).Sharing);
    }

    [Fact]
    public void Resolving_probing_and_reading_a_binding_change_nothing_on_disk()
    {
        var ws = _tree.Workspace("WS");
        _tree.Dir("plain");
        _tree.Junction("link", ws);
        var before = _tree.Snapshot();

        foreach (var path in new[] { ws, Path.Combine(ws, @"new\a.ipt"), Path.Combine(_tree.Root, @"plain\x\y"), Path.Combine(_tree.Root, @"link\a.ipt"), Path.Combine(_tree.Root, "missing") })
        {
            _paths.Resolve(path);
            _paths.HasManifest(path);
            _paths.ReadBinding(path);
        }
        var planner = new WorkspaceLockPlanner(_paths);
        planner.Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", Path.Combine(_tree.Root, "NewWS")));
        planner.Plan(WorkspaceLockRequest.ForGetLatest("Get Latest", Path.Combine(ws, "nested")));                 // refused: nested
        planner.Plan(WorkspaceLockRequest.ForDocument("Checkout", Path.Combine(_tree.Root, @"plain\a.ipt")));      // refused: not in a workspace
        planner.Plan(WorkspaceLockRequest.ForCopyDesign("Apply Copy Design", "http://localhost:3100", "k",
            new[] { Path.Combine(ws, "a.ipt") }, new[] { Path.Combine(_tree.Root, @"out\a2.ipt") }));

        Assert.Equal(before, _tree.Snapshot());
        Assert.False(Directory.Exists(Path.Combine(_tree.Root, "NewWS")));
        Assert.False(Directory.Exists(Path.Combine(ws, ".arch", "locks")));
    }

    [Fact]
    public void A_binding_is_read_from_the_manifest_fields_the_origin_guard_uses()
    {
        var ws = _tree.Workspace("WS", origin: "http://localhost:3000", organization: "org-7");

        var binding = _paths.ReadBinding(_paths.Resolve(ws).Canonical);

        Assert.True(binding.ManifestPresent);
        Assert.Equal("http://localhost:3000", binding.ServerOrigin);
        Assert.Equal("org-7", binding.OrganizationId);
        Assert.Equal(WorkspaceBindingSnapshot.None, _paths.ReadBinding(_tree.Dir("plain")));
    }
}
