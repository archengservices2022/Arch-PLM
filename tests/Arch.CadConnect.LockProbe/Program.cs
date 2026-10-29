using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
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

            default:
                Console.WriteLine("ERROR unknown " + args[0]);
                return 2;
        }
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
