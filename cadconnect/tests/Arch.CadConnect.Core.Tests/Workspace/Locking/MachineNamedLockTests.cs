using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Principal;
using Arch.CadConnect.Core.Workspace.Locking;
using Microsoft.Win32.SafeHandles;

namespace Arch.CadConnect.Core.Tests.Workspace.Locking;

/// <summary>
/// P6 M4.4: OWNERSHIP of the machine-wide O / D lock (a named kernel event)
/// - first creation wins, atomically, among racing threads and racing
/// processes; an existing object is always refused; a refused or hostile
/// contender cannot release, signal or reset the holder's lock; the object
/// lives exactly until its last handle closes; it sits in the GLOBAL
/// namespace with a security descriptor that admits no other user; and a
/// different object squatting the name fails closed.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class MachineNamedLockTests
{
    private static string NewKey() => "m44-own-" + Guid.NewGuid().ToString("N");

    private static bool CanTake(string key)
    {
        var result = MachineNamedLock.Acquire(LockScope.Operation, key);
        result.Handle?.Dispose();
        return result.Held;
    }

    // ---- 1, 2, 4: first creator owns; an existing object is always refused ------------

    [Fact]
    public void The_first_creator_owns_and_every_later_creation_is_refused_until_it_releases()
    {
        var key = NewKey();
        var owner = MachineNamedLock.Acquire(LockScope.Operation, key);
        Assert.True(owner.Held);

        for (var i = 0; i < 20; i++)
        {
            var again = MachineNamedLock.Acquire(LockScope.Operation, key);
            Assert.False(again.Held);
            Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, again.ErrorCode);
        }

        owner.Handle!.Dispose();
        Assert.True(CanTake(key));
    }

    [Fact]
    public void Exactly_one_of_many_racing_threads_becomes_the_owner()
    {
        for (var round = 0; round < 20; round++)
        {
            var key = NewKey();
            const int racers = 16;
            var results = new LockHandleResult[racers];
            using var barrier = new Barrier(racers);
            var threads = Enumerable.Range(0, racers).Select(i => new Thread(() =>
            {
                barrier.SignalAndWait();
                results[i] = MachineNamedLock.Acquire(LockScope.Operation, key);
            })).ToArray();
            foreach (var t in threads) t.Start();
            foreach (var t in threads) t.Join();

            Assert.Equal(1, results.Count(r => r.Held));
            Assert.All(results.Where(r => !r.Held), r => Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, r.ErrorCode));
            foreach (var r in results) r.Handle?.Dispose();
        }
    }

    [Fact]
    public void Exactly_one_of_many_racing_processes_becomes_the_owner()
    {
        var key = NewKey();
        var goName = @"Local\arch-m44-go-" + Guid.NewGuid().ToString("N");
        using var go = new EventWaitHandle(false, EventResetMode.ManualReset, goName);
        var probes = Enumerable.Range(0, 8).Select(_ => LockProbeProcess.Start("race", "op", key, goName)).ToList();
        try
        {
            Assert.All(probes, p => Assert.Equal("READY", p.ReadLine()));
            go.Set();
            var lines = probes.Select(p => p.ReadLine()).ToArray();

            Assert.Equal(1, lines.Count(l => l == "HELD"));
            Assert.Equal(7, lines.Count(l => l == "REFUSED " + WorkspaceLockErrorCodes.OperationLocked));
            Assert.False(CanTake(key), "the owning process is still alive");

            var owner = probes[Array.IndexOf(lines, "HELD")];
            owner.Send("release");
            Assert.Equal("RELEASED", owner.ReadLine());
            Assert.True(Eventually.True(() => CanTake(key)));
        }
        finally
        {
            foreach (var p in probes) p.Dispose();
        }
    }

    // ---- 3: access denied fails closed -------------------------------------------------

    [Fact]
    public void An_object_this_user_may_not_open_is_held_not_bypassed()
    {
        // Created by the probe with an EMPTY access list - what another
        // Windows user's object looks like from here.
        var key = NewKey();
        var (probe, line) = LockProbeProcess.Run("m-denied", "op", key);
        using (probe)
        {
            Assert.Equal("HELD", line);
            for (var i = 0; i < 10; i++)
            {
                Assert.Equal(WorkspaceLockErrorCodes.OperationLocked, MachineNamedLock.Acquire(LockScope.Operation, key).ErrorCode);
            }
            Assert.Equal("PONG", Ping(probe));
        }
    }

    // ---- 5: a contender cannot release, signal or reset the holder ------------------------

    [Fact]
    public void Refused_contenders_closing_their_handles_never_release_the_holder()
    {
        var key = NewKey();
        var (holder, line) = LockProbeProcess.Run("m", "op", key);
        using (holder)
        {
            Assert.Equal("HELD", line);
            for (var i = 0; i < 50; i++)
            {
                Assert.False(MachineNamedLock.Acquire(LockScope.Operation, key).Held);
            }
            var (other, otherLine) = LockProbeProcess.Run("m", "op", key);
            using (other) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.OperationLocked, otherLine);
            Assert.Equal("PONG", Ping(holder));
            Assert.False(CanTake(key));
        }
    }

    [Fact]
    public void Signaling_or_resetting_the_event_does_not_release_the_lock()
    {
        var key = NewKey();
        var (holder, line) = LockProbeProcess.Run("m", "op", key);
        using (holder)
        {
            Assert.Equal("HELD", line);
            // A hostile same-user process opening the event with MODIFY rights.
            using (var hostile = Native.OpenEventW(Native.EventModifyState | Native.Synchronize, false, MachineNamedLock.NameFor(LockScope.Operation, key)))
            {
                Assert.False(hostile.IsInvalid);
                Assert.True(Native.SetEvent(hostile));
                Assert.True(Native.ResetEvent(hostile));
                Assert.True(Native.SetEvent(hostile));
            }
            Assert.False(CanTake(key));
            Assert.Equal("PONG", Ping(holder));
        }
    }

    [Fact]
    public void A_refused_contender_s_handle_cannot_signal_or_reset_the_event()
    {
        // Our own contender handles carry SYNCHRONIZE only.
        var key = NewKey();
        var owner = MachineNamedLock.Acquire(LockScope.Operation, key);
        try
        {
            using var synchronizeOnly = Native.OpenEventW(Native.Synchronize, false, MachineNamedLock.NameFor(LockScope.Operation, key));
            Assert.False(synchronizeOnly.IsInvalid);
            Assert.False(Native.SetEvent(synchronizeOnly));
            Assert.Equal(5, Marshal.GetLastPInvokeError()); // ERROR_ACCESS_DENIED
            Assert.False(Native.SetEvent((SafeWaitHandle)owner.Handle!), "the owner's own handle has no modify right either");
        }
        finally
        {
            owner.Handle!.Dispose();
        }
    }

    // ---- 6: lifetime = the last handle -----------------------------------------------

    [Fact]
    public void The_object_lives_until_its_last_handle_closes_and_only_then_disappears()
    {
        var key = NewKey();
        var name = MachineNamedLock.NameFor(LockScope.Operation, key);
        var owner = MachineNamedLock.Acquire(LockScope.Operation, key);
        var extra = Native.OpenEventW(Native.Synchronize, false, name);
        Assert.False(extra.IsInvalid);

        owner.Handle!.Dispose();
        // Someone still holds a handle: the object exists, so nobody may own it.
        Assert.False(CanTake(key));

        extra.Dispose();
        Assert.True(Native.OpenEventW(Native.Synchronize, false, name) is { IsInvalid: true }, "the object should be gone");
        Assert.True(CanTake(key));
    }

    [Fact]
    public void A_machine_lease_reachable_only_from_its_work_closure_stays_held_through_garbage_collection()
    {
        var key = NewKey();
        var release = HoldInsideClosure(key);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        var (probe, line) = LockProbeProcess.Run("m", "op", key);
        using (probe) Assert.Equal("REFUSED " + WorkspaceLockErrorCodes.OperationLocked, line);
        release();
        var (after, afterLine) = LockProbeProcess.Run("m", "op", key);
        using (after) Assert.Equal("HELD", afterLine);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static Action HoldInsideClosure(string key)
    {
        var result = MachineNamedLock.Acquire(LockScope.Operation, key);
        Assert.True(result.Held);
        var handle = result.Handle!;
        return () => handle.Dispose();
    }

    // ---- 7: global namespace, security descriptor, naming ---------------------------------

    [Fact]
    public void The_object_is_created_in_the_global_namespace_shared_by_every_session()
    {
        var key = NewKey();
        var owner = MachineNamedLock.Acquire(LockScope.Destination, key);
        try
        {
            var kernelName = Native.ObjectName((SafeWaitHandle)owner.Handle!);
            var expected = @"\BaseNamedObjects\" + MachineNamedLock.NameFor(LockScope.Destination, key)["Global\\".Length..];
            // A session-local object would be \Sessions\<n>\BaseNamedObjects\...
            Assert.Equal(expected, kernelName);
        }
        finally
        {
            owner.Handle!.Dispose();
        }
    }

    [Fact]
    public void The_object_is_owned_by_this_user_and_its_access_list_admits_no_other_principal()
    {
        var key = NewKey();
        var owner = MachineNamedLock.Acquire(LockScope.Operation, key);
        try
        {
            using var readControl = Native.OpenEventW(Native.ReadControl, false, MachineNamedLock.NameFor(LockScope.Operation, key));
            var sddl = Native.Sddl(readControl);

            // The object takes the creating token's default owner. For a normal
            // (non-elevated) user that is the user's own SID. For an ELEVATED
            // administrator token (e.g. a CI runner) Windows makes BUILTIN\
            // Administrators ("BA") the default owner instead. Accept BA only
            // in that case; a non-elevated run must still be owned by the user.
            var me = WindowsIdentity.GetCurrent();
            var userOwner = "O:" + me.User!.Value;
            var elevatedAdmin = new WindowsPrincipal(me).IsInRole(WindowsBuiltInRole.Administrator);
            var ownedAsExpected = sddl.StartsWith(userOwner, StringComparison.Ordinal)
                || (elevatedAdmin && sddl.StartsWith("O:BA", StringComparison.Ordinal));
            Assert.True(ownedAsExpected, $"unexpected owner (elevated admin: {elevatedAdmin}): {sddl}");
            Assert.Contains("D:", sddl, StringComparison.Ordinal);
            Assert.DoesNotContain("D:NO_ACCESS_CONTROL", sddl, StringComparison.Ordinal); // never a NULL DACL
            foreach (var everyoneLike in new[] { ";;;WD)", ";;;AU)", ";;;BU)", ";;;IU)", ";;;AN)" })
            {
                Assert.DoesNotContain(everyoneLike, sddl, StringComparison.Ordinal);
            }
        }
        finally
        {
            owner.Handle!.Dispose();
        }
    }

    [Theory]
    [InlineData("mutex")]
    [InlineData("semaphore")]
    public void A_different_object_squatting_the_name_fails_closed(string kind)
    {
        var key = NewKey();
        var name = MachineNamedLock.NameFor(LockScope.Operation, key);
        using (WaitHandle squatter = kind == "mutex" ? new Mutex(false, name) : new Semaphore(1, 1, name))
        {
            var result = MachineNamedLock.Acquire(LockScope.Operation, key);
            Assert.False(result.Held);
            Assert.Equal(WorkspaceLockErrorCodes.LockUnavailable, result.ErrorCode);
        }
        Assert.True(CanTake(key));
    }

    [Fact]
    public void Names_are_deterministic_scoped_global_and_free_of_the_key()
    {
        var a = MachineNamedLock.NameFor(LockScope.Operation, "http://localhost:3100|Key-1");

        Assert.Equal(a, MachineNamedLock.NameFor(LockScope.Operation, "http://localhost:3100|Key-1"));
        Assert.NotEqual(a, MachineNamedLock.NameFor(LockScope.Operation, "http://localhost:3100|key-1"));
        Assert.NotEqual(a, MachineNamedLock.NameFor(LockScope.Destination, "http://localhost:3100|Key-1"));
        Assert.Matches(@"^Global\\ArchCadConnect\.Lock\.op\.[0-9A-F]{40}$", a);
    }

    private static string Ping(LockProbeProcess probe)
    {
        probe.Send("ping");
        return probe.ReadLine();
    }

    private static class Native
    {
        public const uint EventModifyState = 0x0002;
        public const uint Synchronize = 0x00100000;
        public const uint ReadControl = 0x00020000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeWaitHandle OpenEventW(uint desiredAccess, bool inheritHandle, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetEvent(SafeWaitHandle handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool ResetEvent(SafeWaitHandle handle);

        public static string ObjectName(SafeWaitHandle handle)
        {
            var buffer = Marshal.AllocHGlobal(4096);
            try
            {
                Assert.Equal(0, NtQueryObject(handle, 1, buffer, 4096, out _)); // ObjectNameInformation
                var length = (ushort)Marshal.ReadInt16(buffer, 0);
                var text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
                return Marshal.PtrToStringUni(text, length / 2);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static string Sddl(SafeWaitHandle handle)
        {
            const int kernelObject = 6;
            const int ownerAndDacl = 0x1 | 0x4;
            Assert.Equal(0u, GetSecurityInfo(handle, kernelObject, ownerAndDacl, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out var descriptor));
            try
            {
                Assert.True(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, ownerAndDacl, out var text, IntPtr.Zero));
                try { return Marshal.PtrToStringUni(text)!; }
                finally { LocalFree(text); }
            }
            finally
            {
                LocalFree(descriptor);
            }
        }

        [DllImport("ntdll.dll")]
        private static extern int NtQueryObject(SafeWaitHandle handle, int informationClass, IntPtr information, int length, out int returnLength);

        [DllImport("advapi32.dll")]
        private static extern uint GetSecurityInfo(SafeWaitHandle handle, int objectType, int securityInfo,
            IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr securityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint information, out IntPtr text, IntPtr length);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);
    }
}
