using System.ComponentModel;
using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using Arch.CadConnect.Api;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;
using Microsoft.Win32.SafeHandles;

[assembly: SupportedOSPlatform("windows")]

namespace Arch.CadConnect.LockProbe;

/// <summary>
/// Takes ONE lock with the production Core classes, prints <c>HELD</c> or
/// <c>REFUSED &lt;code&gt;</c>, and - while held - obeys one command per stdin
/// line: <c>release</c> (dispose, print <c>RELEASED</c>, exit 0), <c>exit</c>
/// (leave without disposing - the OS closes the handle), <c>failfast</c>
/// (crash), <c>ping</c>. End of input leaves like <c>exit</c>.
/// <list type="bullet">
/// <item><c>w &lt;root&gt; shared|exclusive</c> - the W primitive.</item>
/// <item><c>m op|dst &lt;key&gt;</c> - the machine-wide O / D primitive.</item>
/// <item><c>race op|dst &lt;key&gt; &lt;go-event&gt;</c> - prints <c>READY</c>, waits for
///  the parent to signal the go event, then takes the machine lock.</item>
/// <item><c>m-denied op|dst &lt;key&gt;</c> - the same named event, created
///  with an EMPTY access list, exactly as another Windows user's event looks
///  to this user.</item>
/// <item><c>doc &lt;file&gt;</c>, <c>getlatest &lt;root&gt;</c> - the whole stack
///  (planner + acquirer + real path system).</item>
/// <item><c>read &lt;root&gt;</c> - prints the holder record, or <c>NONE</c>.</item>
/// <item><c>manifest-save &lt;root&gt; &lt;step&gt;|none [&lt;file&gt; &lt;checkoutId&gt;]</c> -
///  loads the manifest, adds that checkout to that entry if given, and saves it
///  with the production code, TERMINATING this process, with no cleanup of any
///  kind, on reaching that <see cref="ManifestSaveStep"/>.</item>
/// <item><c>hang &lt;text&gt;</c> - prints that text, then never ends.</item>
/// <item><c>self-doc &lt;file&gt;</c> - runs an operation through
///  <see cref="WorkspaceCommandScope"/> with no command in scope, so it takes the
///  lock itself and proves its root; prints <c>HELD &lt;proved roots&gt;</c> from
///  inside the operation, then never ends.</item>
/// <item><c>getlatest-status-hang &lt;root&gt; &lt;number&gt; &lt;resolve.json&gt; &lt;plan.json&gt;</c> -
///  the production Get Latest (<see cref="ArchApiClient"/>) against a scripted
///  server whose checkout status never answers; prints <c>ASKING</c> when a status
///  request arrives, and never ends.</item>
/// </list>
/// </summary>
internal static class Program
{
    private const int AlreadyExists = 183;

    private static int Main(string[] args)
    {
        try
        {
            return Run(args);
        }
        catch (Exception ex)
        {
            Console.WriteLine("ERROR " + ex.GetType().Name);
            Console.Error.WriteLine(ex);
            return 9;
        }
    }

    private static int Run(string[] args)
    {
        if (args.Length < 2)
        {
            Console.WriteLine("ERROR usage");
            return 2;
        }
        switch (args[0])
        {
            case "read":
                var record = WorkspaceFileLock.ReadHolder(args[1]);
                Console.WriteLine(record is null ? "NONE" : "RECORD " + record.ProcessId + " " + record.Mode + " " + record.Command);
                return 0;

            case "w":
                var mode = args[2] == "shared" ? LockMode.Shared : LockMode.Exclusive;
                return Hold(WorkspaceFileLock.Acquire(args[1], mode, WorkspaceLockHolderRecord.ForCurrentProcess("probe", mode)));

            case "m":
                return Hold(MachineNamedLock.Acquire(Scope(args[1]), args[2]));

            case "m-denied":
                return HoldDenied(MachineNamedLock.NameFor(Scope(args[1]), args[2]));

            case "race":
                // Wait for the parent's start signal so every racer creates at once.
                using (var go = EventWaitHandle.OpenExisting(args[3]))
                {
                    Console.WriteLine("READY");
                    go.WaitOne(TimeSpan.FromSeconds(30));
                }
                return Hold(MachineNamedLock.Acquire(Scope(args[1]), args[2]));

            case "doc":
                return HoldAcquisition(Acquirer().TryAcquire(WorkspaceLockRequest.ForDocument("probe", args[1])));

            case "getlatest":
                return HoldAcquisition(Acquirer().TryAcquire(WorkspaceLockRequest.ForGetLatest("probe", args[1])));

            case "manifest-save":
                return SaveManifest(args[1], args[2], args.Length > 4 ? args[3] : null, args.Length > 4 ? args[4] : null);

            case "hang":
                Console.WriteLine(args[1]);
                Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite);
                return 0;

            case "self-doc":
                return WorkspaceCommandScope.RunAsync(WorkspaceLockRequest.ForDocument("probe", args[1]), () => { }, () =>
                {
                    Console.WriteLine("HELD " + WorkspaceCommandScope.Current!.Lease.HeldRoots.Count);
                    Console.Out.Flush();
                    Thread.Sleep(Timeout.Infinite);
                    return Task.FromResult(0);
                }, refusal => new InvalidOperationException(refusal.ErrorCode)).GetAwaiter().GetResult();

            case "getlatest-status-hang":
                return GetLatestHangingOnStatus(args[1], args[2], args[3], args[4]).GetAwaiter().GetResult();

            default:
                Console.WriteLine("ERROR unknown " + args[0]);
                return 2;
        }
    }

    private static int SaveManifest(string root, string terminateAt, string? file, string? checkoutId)
    {
        var (manifest, _) = WorkspaceManifest.Load(root);
        if (file is not null)
        {
            manifest.StageCheckedOut(file, new WorkspaceCheckoutBinding
            {
                CheckoutId = checkoutId!,
                BaseFileVersionId = "fv_added",
                BaseVersionNumber = 1,
                BaseChecksum = new string('a', 64),
                BaseFileSize = 1,
                CheckedOutAtUtc = DateTimeOffset.UnixEpoch,
            });
        }
        manifest.SaveIfUnchangedSinceLoad(atStep: step =>
        {
            if (step.ToString() == terminateAt)
            {
                Console.WriteLine("TERMINATING " + step);
                Console.Out.Flush();
                Process.GetCurrentProcess().Kill();
                Thread.Sleep(Timeout.Infinite);
            }
        });
        Console.WriteLine("SAVED");
        return 0;
    }

    private static async Task<int> GetLatestHangingOnStatus(string root, string documentNumber, string resolveFile, string planFile)
    {
        var server = ArchServerUri.Parse("https://plm.example.com");
        var session = new DesktopSession(
            server,
            new ArchIdentity("u1", "Probe User", "probe@orga.com", "ENGINEER", "org1", "ORGA", "Org A"),
            "arch_dt_PROBETOKEN123456",
            DateTimeOffset.UtcNow.AddHours(1),
            DateTimeOffset.UtcNow);
        var handler = new HangingStatusHandler(File.ReadAllText(resolveFile), File.ReadAllText(planFile));
        var client = new ArchApiClient(server, new HttpClient(handler), new ArchApiClientOptions { Timeout = TimeSpan.FromMinutes(10) });
        await client.GetLatestAsync(session, new GetLatestRequest { Root = CadDocumentLookup.ByNumber(documentNumber), WorkspaceRoot = root });
        Console.WriteLine("FINISHED");
        return 0;
    }

    /// <summary>Answers resolve and the plan; a checkout status request is never answered.</summary>
    private sealed class HangingStatusHandler(string resolve, string plan) : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path.EndsWith("/resolve", StringComparison.Ordinal))
            {
                return Json(resolve);
            }
            if (path.EndsWith("/workspace-plan", StringComparison.Ordinal))
            {
                return Json(plan);
            }
            if (path.EndsWith("/checkout", StringComparison.Ordinal) && request.Method == HttpMethod.Get)
            {
                Console.WriteLine("ASKING");
                Console.Out.Flush();
                await Task.Delay(Timeout.Infinite, CancellationToken.None);
            }
            return new HttpResponseMessage(HttpStatusCode.NotFound) { Content = new StringContent("{\"error\":\"no route\"}", Encoding.UTF8, "application/json") };
        }

        private static HttpResponseMessage Json(string body) =>
            new(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private static WorkspaceLockAcquirer Acquirer() =>
        new(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

    private static LockScope Scope(string value) => value == "op" ? LockScope.Operation : LockScope.Destination;

    private static int Hold(LockHandleResult result)
    {
        if (!result.Held)
        {
            Console.WriteLine("REFUSED " + result.ErrorCode);
            return 0;
        }
        return Serve(result.Handle!);
    }

    private static int HoldAcquisition(WorkspaceLockAcquisition acquisition)
    {
        if (!acquisition.Acquired)
        {
            Console.WriteLine("REFUSED " + acquisition.Refusal!.ErrorCode);
            return 0;
        }
        return Serve(acquisition.Lease!);
    }

    private static int Serve(IDisposable handle)
    {
        Console.WriteLine("HELD");
        while (Console.ReadLine() is { } line)
        {
            switch (line.Trim())
            {
                case "release":
                    handle.Dispose();
                    Console.WriteLine("RELEASED");
                    return 0;
                case "exit":
                    Environment.Exit(3);
                    break;
                case "failfast":
                    Environment.FailFast("LockProbe: simulated crash while holding a lock");
                    break;
                case "ping":
                    Console.WriteLine("PONG");
                    break;
            }
        }
        Environment.Exit(4); // input closed: leave WITHOUT disposing
        return 4;
    }

    private static int HoldDenied(string name)
    {
        // "D:" = a DACL with no entries: nobody - not even this user - may open it.
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:", 1, out var descriptor, IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            var attributes = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor, Inherit = 0 };
            var handle = CreateEventW(ref attributes, true, false, name);
            var error = Marshal.GetLastWin32Error();
            if (handle.IsInvalid)
            {
                throw new Win32Exception(error);
            }
            if (error == AlreadyExists)
            {
                handle.Dispose();
                Console.WriteLine("REFUSED exists");
                return 0;
            }
            return Serve(handle);
        }
        finally
        {
            LocalFree(descriptor);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        public int Inherit;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string descriptor, uint revision, out IntPtr securityDescriptor, IntPtr size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle CreateEventW(ref SecurityAttributes attributes, bool manualReset, bool initialState, string name);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
