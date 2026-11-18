using System.Runtime.Versioning;
using System.Text.Json;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R10 NO-GO corrections (MAJOR 1, MAJOR 4 end to end,
///  first saves): Get Latest refuses a session for another server before it
///  touches anything, a late status answer authorizes nothing, and a new workspace
///  still takes its lock before its lease and saves. Test IDs follow the approved
///  correction plan.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private const string RecoveryOp = "0123456789abcdef0123456789abcdef";

    private static readonly ArchServerUri OtherServer = ArchServerUri.Parse("https://other.example.com");

    private GetLatestOrchestrator OrchestratorFor(
        FakeHttpHandler handler,
        ArchServerUri server,
        GetLatestTestHooks? hooks = null,
        Func<IArchSession, string, CancellationToken, Task<ServerCheckoutStatus>>? checkoutStatus = null)
    {
        var http = new HttpClient(handler);
        return new GetLatestOrchestrator(
            hooks ?? new GetLatestTestHooks(),
            server,
            resolve: (s, lu, c) => GetLatestOrchestrator.ResolveViaHttpAsync(server, s, http, lu, TimeSpan.FromSeconds(5), c),
            planClientFactory: s => new WorkspacePlanClient(server, s, http, TimeSpan.FromSeconds(5)),
            downloaderFactory: s => new HttpContentDownloader(server, s, http),
            materializer: new WorkspaceMaterializer(NoEditorProbe.Instance),
            checkoutStatus: checkoutStatus ?? ((s, id, c) => new CheckoutHttpClient(server, s, http, TimeSpan.FromSeconds(5)).GetStatusStrictAsync(id, c)));
    }

    private GetLatestRequest PartRequest() => new() { Root = CadDocumentLookup.ByNumber("PRT-1"), WorkspaceRoot = _root };

    private string[] TreeSnapshot() => !Directory.Exists(_root) ? [] : Directory
        .EnumerateFileSystemEntries(_root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
        .Select(p => File.Exists(p) ? $"F {p[_root.Length..]} {Sha(File.ReadAllBytes(p))} {File.GetAttributes(p)}" : $"D {p[_root.Length..]}")
        .OrderBy(s => s, StringComparer.Ordinal)
        .ToArray();

    // ---- O: one server -------------------------------------------------------------

    [Fact]
    [Trait("PackageC", "R10Fix")]
    public async Task O1_a_direct_run_for_another_servers_session_is_refused_before_anything()
    {
        var handler = Server(RootPart);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => OrchestratorFor(handler, OtherServer).RunAsync(WorkspaceTestSession.Make(), PartRequest()));

        Assert.Equal(GetLatestOrchestrator.OtherServerMessage, ex.Message);
        Assert.Empty(handler.Requests);
        Assert.False(Directory.Exists(Path.Combine(_root, ".arch")));
        Assert.Empty(TreeSnapshot());
    }

    [Fact]
    [Trait("PackageC", "R10Fix")]
    public async Task O2_the_public_client_for_another_server_is_refused_before_anything()
    {
        var handler = Server(RootPart);
        var client = new ArchApiClient(OtherServer, new HttpClient(handler), new ArchApiClientOptions { Timeout = TimeSpan.FromSeconds(5) });

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => client.GetLatestAsync(WorkspaceTestSession.Make(), PartRequest()));

        Assert.Equal(GetLatestOrchestrator.OtherServerMessage, ex.Message);
        Assert.Empty(handler.Requests);
        Assert.False(Directory.Exists(Path.Combine(_root, ".arch")));
    }

    /// <summary>A healthy workspace that then shows an interrupted save and a
    ///  pending replacement record, with a recovery copy beside it.</summary>
    private async Task<string[]> WorkspaceAwaitingRecovery()
    {
        await BoundPartWithNoMarker();
        File.Copy(ManifestPath, $"{ManifestPath}.{RecoveryOp}.previous");
        var recovery = Directory.CreateDirectory(Path.Combine(_root, ".arch", ".recovery")).FullName;
        File.WriteAllBytes(Path.Combine(recovery, $"part.ipt.{RecoveryOp}"), EditedBytes);
        File.WriteAllText(Path.Combine(recovery, $"part.ipt.{RecoveryOp}{WorkspaceRecoveryFolder.JournalSuffix}"), """{"note":"planted"}""");
        Assert.True(WorkspaceRecoveryState.Inspect(_root).IsRecoveryRequired);
        return TreeSnapshot();
    }

    [Theory]
    [InlineData("orchestrator")]
    [InlineData("client")]
    [Trait("PackageC", "R10Fix")]
    public async Task O3_X5_a_refusal_leaves_pending_recovery_records_and_CAD_bytes_exactly_as_they_were(string entrypoint)
    {
        var before = await WorkspaceAwaitingRecovery();
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => entrypoint == "orchestrator"
            ? OrchestratorFor(handler, OtherServer).RunAsync(WorkspaceTestSession.Make(), PartRequest())
            : new ArchApiClient(OtherServer, new HttpClient(handler), new ArchApiClientOptions { Timeout = TimeSpan.FromSeconds(5) })
                .GetLatestAsync(WorkspaceTestSession.Make(), PartRequest()));

        Assert.Equal(before, TreeSnapshot());
        Assert.Empty(handler.Requests);
        Assert.True(WorkspaceRecoveryState.Inspect(_root).IsRecoveryRequired);
    }

    [Fact]
    [Trait("PackageC", "R10Fix")]
    [SupportedOSPlatform("windows")] // takes a real Windows workspace lock as the command
    public async Task O4_a_refusal_under_a_command_never_takes_its_admission_and_a_valid_run_still_borrows_it()
    {
        var held = new CommandLockGate(
            new WorkspaceLockAcquirer(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance), null)
            .Admit(WorkspaceLockRequest.ForGetLatest("Get Latest", _root), () => true).Lock!;
        var refusedHandler = Server(RootPart);
        string? stageAfterRefusal = null;
        MaterializationReport? report = null;

        await held.RunAsync(async _ =>
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => OrchestratorFor(refusedHandler, OtherServer).RunAsync(WorkspaceTestSession.Make(), PartRequest()));
            stageAfterRefusal = held.StageName;
            report = await Run(Server(RootPart), "PRT-1");
        }, CancellationToken.None);

        Assert.Equal("Open", stageAfterRefusal);
        Assert.Empty(refusedHandler.Requests);
        Assert.Equal(MaterializationStatus.Downloaded, report!.Results.Single().Status);
        Assert.True(held.IsReleased);
    }

    [Theory]
    [InlineData("https://PLM.Example.COM")]
    [InlineData("https://plm.example.com:443")]
    [Trait("PackageC", "R10Fix")]
    public async Task O5_the_same_origin_written_differently_is_the_same_server(string written)
    {
        var report = await OrchestratorFor(Server(RootPart), ArchServerUri.Parse(written)).RunAsync(WorkspaceTestSession.Make(), PartRequest());

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
    }

    // ---- F: first saves --------------------------------------------------------------

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [Trait("PackageC", "R10Fix")]
    public async Task F1_F2_a_new_root_takes_its_lock_before_its_lease_and_saves(bool rootExists)
    {
        if (!rootExists)
        {
            Directory.Delete(_root, recursive: true);
        }
        Assert.False(Directory.Exists(Path.Combine(_root, ".arch")));
        bool? lockHeldAtLease = null;
        var hooks = new GetLatestTestHooks(OnArchLease: _ => lockHeldAtLease = WorkspaceLockIsHeld());

        var report = await OrchestratorFor(Server(RootPart), WorkspaceTestSession.Server, hooks).RunAsync(WorkspaceTestSession.Make(), PartRequest());

        Assert.True(lockHeldAtLease);
        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(WorkspaceManifestLoadStatus.Loaded, WorkspaceManifest.Load(_root).Status);
        Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(_root).Status);
        Assert.False(WorkspaceLockIsHeld());
    }

    // ---- X3: a run killed while it asks about checkouts ----------------------------

    /// <summary>One child process running the probe; killed with no cleanup.</summary>
    private sealed class Child : IDisposable
    {
        private readonly System.Diagnostics.Process _process;

        private Child(System.Diagnostics.Process process) => _process = process;

        public static Child Start(params string[] args)
        {
            var exe = Path.Combine(AppContext.BaseDirectory, "Arch.CadConnect.LockProbe.exe");
            Assert.True(File.Exists(exe), "LockProbe was not built next to the tests: " + exe);
            var start = new System.Diagnostics.ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in args) start.ArgumentList.Add(a);
            return new Child(System.Diagnostics.Process.Start(start)!);
        }

        public string ReadLine()
        {
            var read = _process.StandardOutput.ReadLineAsync();
            Assert.True(read.Wait(TimeSpan.FromSeconds(30)), "the child did not answer");
            return read.Result ?? "(ended: " + _process.StandardError.ReadToEnd() + ")";
        }

        /// <summary>TerminateProcess: no finally block, no Dispose runs.</summary>
        public void Kill()
        {
            _process.Kill(entireProcessTree: true);
            Assert.True(_process.WaitForExit(15_000), "the child did not die");
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

    private static bool Eventually(Func<bool> condition)
    {
        var until = Environment.TickCount64 + 10_000;
        while (!condition())
        {
            if (Environment.TickCount64 > until) return false;
            Thread.Sleep(50);
        }
        return true;
    }

    private string[] TreeSnapshotWithoutLocks() =>
        TreeSnapshot().Where(s => !s.Contains(@"\.arch\locks", StringComparison.OrdinalIgnoreCase)).ToArray();

    [Fact]
    [Trait("PackageC", "R10Fix")]
    public async Task X3_a_run_killed_while_asking_about_checkouts_changes_nothing_and_the_next_run_is_normal()
    {
        await BoundPartWithNoMarker();
        var script = Directory.CreateDirectory(_root + "-script").FullName;
        try
        {
            var resolve = Path.Combine(script, "resolve.json");
            var plan = Path.Combine(script, "plan.json");
            File.WriteAllText(resolve, JsonSerializer.Serialize(new
            {
                contract = "arch-plm.desktop-cad-document.v1",
                cadDocumentId = RootPart.Id,
                documentNumber = RootPart.Number,
                fileName = RootPart.FileName,
                cadType = RootPart.CadType,
            }));
            File.WriteAllText(plan, PlanJson(RootPart));
            var before = TreeSnapshotWithoutLocks();

            using (var child = Child.Start("getlatest-status-hang", _root, RootPart.Number, resolve, plan))
            {
                Assert.Equal("ASKING", child.ReadLine());
                Assert.True(WorkspaceLockIsHeld());
                child.Kill();
            }

            Assert.True(Eventually(() => !WorkspaceLockIsHeld()), "the OS did not release the dead run's lock");
            Assert.Equal(before, TreeSnapshotWithoutLocks());
            Assert.Equal(WorkspaceRecoveryStatus.Healthy, WorkspaceRecoveryState.Inspect(_root).Status);

            var report = await Run(Server(RootPart), "PRT-1");
            Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        }
        finally
        {
            Directory.Delete(script, recursive: true);
        }
    }

    // ---- R8: a late answer, end to end ----------------------------------------------

    [Fact]
    [Trait("PackageC", "R10Fix")]
    public async Task R8_an_available_answer_that_arrives_after_the_deadline_changes_nothing()
    {
        await BoundPartWithNoMarker();
        ManagedFileGuard.SetWritable(PartPath);
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        var entry = JsonOf(Entry(PartPath));
        var latched = new TaskCompletionSource();
        var answered = false;
        var hooks = new GetLatestTestHooks(
            StatusDeadline: TimeSpan.FromSeconds(1), // CI: generous; the answer still arrives only after the stop
            Reconciler: new CheckoutStatusReconcilerHooks(OnStopLatched: latched.SetResult));

        var report = await OrchestratorFor(Server(RootPart), WorkspaceTestSession.Server, hooks, async (_, _, _) =>
        {
            await latched.Task.WaitAsync(TimeSpan.FromSeconds(20)); // ignores cancellation
            answered = true;
            return new ServerCheckoutStatus(ServerCheckoutState.Available);
        }).RunAsync(WorkspaceTestSession.Make(), PartRequest());

        Assert.True(answered);
        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Contains("not-checked", result.Reason);
        Assert.False(report.ReachedValidState);
        Assert.Contains("not checked", report.ToSummaryLine());
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
    }
}
