using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>A throwaway folder tree under %TEMP% - never a workspace or
///  evidence folder of the live environment.</summary>
[SupportedOSPlatform("windows")]
internal sealed class TempTree : IDisposable
{
    private readonly List<string> _junctions = new();

    public TempTree()
    {
        Root = Path.Combine(Path.GetTempPath(), "arch-m44-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
    }

    public string Root { get; }

    public string Dir(string relative)
    {
        var path = Path.Combine(Root, relative);
        Directory.CreateDirectory(path);
        return path;
    }

    public string File(string relative, string content = "x")
    {
        var path = Path.Combine(Root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        System.IO.File.WriteAllText(path, content);
        return path;
    }

    /// <summary>A managed workspace: <c>.arch\workspace.json</c> with a binding.</summary>
    public string Workspace(string relative, string origin = "http://localhost:3100", string organization = "org-1")
    {
        var root = Dir(relative);
        File(Path.Combine(relative, WorkspaceManifest.RelativeManifestPath),
            $"{{\"schema\":\"{WorkspaceManifest.SchemaId}\",\"serverOrigin\":\"{origin}\",\"organizationId\":\"{organization}\",\"entries\":[]}}");
        return root;
    }

    /// <summary>A directory junction (no administrator rights needed).</summary>
    public string Junction(string relativeLink, string target)
    {
        var link = Path.Combine(Root, relativeLink);
        Directory.CreateDirectory(Path.GetDirectoryName(link)!);
        Run("cmd.exe", "/c", "mklink", "/J", link, target);
        _junctions.Add(link);
        return link;
    }

    /// <summary>Every file and folder below the root with its SHA-256 - to
    ///  prove a step created, changed or deleted nothing.</summary>
    public string[] Snapshot()
    {
        var dirs = Directory.EnumerateDirectories(Root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
            .Select(d => "D " + d.Substring(Root.Length));
        var files = Directory.EnumerateFiles(Root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
            .Select(f => "F " + f.Substring(Root.Length) + " " + Hash(f));
        return dirs.Concat(files).OrderBy(s => s, StringComparer.Ordinal).ToArray();
    }

    public static string Hash(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    public static void Run(string file, params string[] args)
    {
        var start = new ProcessStartInfo(file) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) start.ArgumentList.Add(a);
        using var process = Process.Start(start)!;
        process.WaitForExit(30_000);
        Assert.True(process.ExitCode == 0, $"{file} {string.Join(' ', args)} failed: {process.StandardError.ReadToEnd()}");
    }

    public void Dispose()
    {
        foreach (var link in _junctions)
        {
            try { Directory.Delete(link); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        }
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>
/// A scripted <see cref="ILockPathSystem"/> for the planner: paths are their
/// own canonical form unless an alias (a "junction") maps a prefix; locality
/// and sharing come from prefixes; folder identities can be replaced.
/// </summary>
internal sealed class FakeLockPathSystem : ILockPathSystem
{
    private readonly Dictionary<string, ulong> _ids = new(StringComparer.OrdinalIgnoreCase);
    private ulong _nextId = 100;

    public HashSet<string> Directories { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> Files { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, WorkspaceBindingSnapshot> Manifests { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, string> Aliases { get; } = new(StringComparer.OrdinalIgnoreCase);
    public Dictionary<string, PathLocality> Localities { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> SharedRoots { get; } = new(StringComparer.OrdinalIgnoreCase);
    public bool ShareListUnreadable { get; set; }
    public int ResolveCalls { get; private set; }

    public FakeLockPathSystem Dir(params string[] paths)
    {
        foreach (var p in paths)
        {
            for (var d = p; !string.IsNullOrEmpty(d); d = Path.GetDirectoryName(d)) Directories.Add(d);
        }
        return this;
    }

    public FakeLockPathSystem File(params string[] paths)
    {
        foreach (var p in paths)
        {
            Files.Add(p);
            Dir(Path.GetDirectoryName(p)!);
        }
        return this;
    }

    public FakeLockPathSystem Workspace(string root, string origin = "http://localhost:3100")
    {
        Dir(root);
        Manifests[root] = new WorkspaceBindingSnapshot(true, WorkspaceManifest.SchemaId, origin, "org-1");
        return this;
    }

    /// <summary>The folder at <paramref name="path"/> is replaced by another one.</summary>
    public void Replace(string path) => _ids[path] = _nextId++;

    public ResolvedPath Resolve(string path)
    {
        ResolveCalls++;
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) return ResolvedPath.Unresolvable(path ?? "");
        var requested = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
        var canonical = Canonical(requested);
        var locality = Localities.Where(kv => LockPaths.IsSameOrUnder(canonical, kv.Key)).Select(kv => (PathLocality?)kv.Value).FirstOrDefault() ?? PathLocality.Local;
        if (locality == PathLocality.Unresolvable) return ResolvedPath.Unresolvable(requested);

        var exists = Directories.Contains(canonical) || Files.Contains(canonical);
        var ancestor = canonical;
        while (!Directories.Contains(ancestor) && !Files.Contains(ancestor))
        {
            var parent = Path.GetDirectoryName(ancestor);
            if (parent is null) return ResolvedPath.Unresolvable(requested);
            ancestor = parent;
        }
        var sharing = ShareListUnreadable ? ShareExposure.Unknown
            : SharedRoots.Any(r => LockPaths.IsSameOrUnder(canonical, r)) ? ShareExposure.Shared : ShareExposure.NotShared;
        return new ResolvedPath(requested, canonical, exists, exists && Directories.Contains(canonical),
            exists ? Id(canonical) : null, ancestor, Id(ancestor), locality, sharing);
    }

    public bool HasManifest(string directory) => Manifests.ContainsKey(Canonical(Path.TrimEndingDirectorySeparator(directory)));

    public WorkspaceBindingSnapshot ReadBinding(string workspaceRoot) =>
        Manifests.TryGetValue(workspaceRoot, out var binding) ? binding : WorkspaceBindingSnapshot.None;

    private string Canonical(string path)
    {
        foreach (var (link, target) in Aliases)
        {
            if (LockPaths.IsSameOrUnder(path, link)) return target + path.Substring(LockPaths.Trim(link).Length);
        }
        return path;
    }

    private FileIdentity Id(string path)
    {
        if (!_ids.TryGetValue(path, out var id)) _ids[path] = id = _nextId++;
        return new FileIdentity(7, id);
    }
}

/// <summary>Records every lock call; refuses the keys it is told to.</summary>
internal sealed class FakeLockHandleFactory : ILockHandleFactory
{
    public List<string> Calls { get; } = new();
    public List<string> Released { get; } = new();
    public Dictionary<string, string> RefuseKeys { get; } = new(StringComparer.Ordinal);
    public HashSet<string> ThrowOnRelease { get; } = new(StringComparer.Ordinal);
    public string? ThrowOnAcquireKey { get; set; }
    public WorkspaceLockHolderRecord? Holder { get; set; }
    public Action? OnAcquired { get; set; }

    public LockHandleResult AcquireWorkspace(string canonicalRoot, LockMode mode, WorkspaceLockHolderRecord holder) =>
        Acquire($"W:{mode}:{canonicalRoot}", canonicalRoot);

    public LockHandleResult AcquireMachine(LockScope scope, string key) => Acquire($"{scope}:{key}", key);

    public WorkspaceLockHolderRecord? ReadHolder(string canonicalRoot) => Holder;

    private LockHandleResult Acquire(string call, string key)
    {
        Calls.Add(call);
        if (key == ThrowOnAcquireKey) throw new IOException("planted acquire failure");
        if (RefuseKeys.TryGetValue(key, out var code)) return LockHandleResult.Refused(code);
        OnAcquired?.Invoke();
        return LockHandleResult.Acquired(new Handle(this, call));
    }

    private sealed class Handle(FakeLockHandleFactory owner, string call) : IDisposable
    {
        public void Dispose()
        {
            owner.Released.Add(call);
            if (owner.ThrowOnRelease.Contains(call)) throw new IOException("planted release failure");
        }
    }
}

/// <summary>Drives one LockProbe process (see the probe's own doc comment).</summary>
internal sealed class LockProbeProcess : IDisposable
{
    private readonly Process _process;

    private LockProbeProcess(Process process) => _process = process;

    public static LockProbeProcess Start(params string[] args)
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "Arch.CadConnect.LockProbe.exe");
        Assert.True(System.IO.File.Exists(exe), "LockProbe was not built next to the tests: " + exe);
        var start = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) start.ArgumentList.Add(a);
        return new LockProbeProcess(Process.Start(start)!);
    }

    /// <summary>Start, and return the probe's first line (HELD / REFUSED x).</summary>
    public static (LockProbeProcess Probe, string Line) Run(params string[] args)
    {
        var probe = Start(args);
        return (probe, probe.ReadLine());
    }

    public int Id => _process.Id;

    public string ReadLine(int timeoutMs = 20_000)
    {
        var read = _process.StandardOutput.ReadLineAsync();
        if (!read.Wait(timeoutMs))
        {
            throw new TimeoutException("LockProbe did not answer. stderr: " + SafeStderr());
        }
        return read.Result ?? throw new InvalidOperationException("LockProbe ended. stderr: " + SafeStderr());
    }

    public void Send(string line)
    {
        _process.StandardInput.WriteLine(line);
        _process.StandardInput.Flush();
    }

    /// <summary>TerminateProcess - no finally block, no Dispose runs.</summary>
    public void Kill()
    {
        _process.Kill(entireProcessTree: true);
        Assert.True(_process.WaitForExit(15_000), "LockProbe did not die");
    }

    public int WaitForExit()
    {
        Assert.True(_process.WaitForExit(15_000), "LockProbe did not exit");
        return _process.ExitCode;
    }

    public bool HasExited => _process.HasExited;

    private string SafeStderr()
    {
        try { return _process.HasExited ? _process.StandardError.ReadToEnd() : "(running)"; }
        catch (InvalidOperationException) { return "(unavailable)"; }
    }

    public void Dispose()
    {
        try
        {
            if (!_process.HasExited) _process.Kill(entireProcessTree: true);
            _process.WaitForExit(10_000);
        }
        catch (InvalidOperationException) { }
        _process.Dispose();
    }
}

/// <summary>Retries a condition briefly - only for the OS closing a dead
///  process's handles, never for lock contention itself.</summary>
internal static class Eventually
{
    public static bool True(Func<bool> condition, int timeoutMs = 10_000)
    {
        var until = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            if (condition()) return true;
            if (Environment.TickCount64 > until) return false;
            Thread.Sleep(50);
        }
    }
}

[SupportedOSPlatform("windows")]
internal static class NativeTestFile
{
    public static void CreateHardLink(string link, string existing)
    {
        if (!CreateHardLinkW(link, existing, IntPtr.Zero))
        {
            throw new IOException("CreateHardLink failed: " + Marshal.GetLastWin32Error());
        }
    }

    /// <summary>The 8.3 form, or null when the volume has none for this path.</summary>
    public static string? ShortPath(string path)
    {
        var buffer = new char[1024];
        var length = GetShortPathNameW(path, buffer, (uint)buffer.Length);
        if (length == 0 || length >= buffer.Length) return null;
        var result = new string(buffer, 0, (int)length);
        return string.Equals(result, path, StringComparison.OrdinalIgnoreCase) ? null : result;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLinkW(string fileName, string existingFileName, IntPtr securityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetShortPathNameW(string longPath, [Out] char[] shortPath, uint length);
}
