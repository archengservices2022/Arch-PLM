using System.Net;
using System.Text;
using System.Text.Json;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R2: open documents, cancellation between entries,
///  save failures, recovery wording, and the Check In / Undo limit.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private sealed class ScriptedProbe(Func<int, bool> isOpenOnCall) : IEditorDocumentProbe, IEditorDocumentStateProbe
    {
        public int Calls { get; private set; }

        public EditorDocumentState GetDocumentState(string absoluteFilePath) =>
            isOpenOnCall(++Calls) ? EditorDocumentState.Open : EditorDocumentState.Closed;

        public bool IsOpenForEditing(string absoluteFilePath) => throw new InvalidOperationException("Get Latest uses the state probe.");
    }

    private sealed class PlainProbe : IEditorDocumentProbe
    {
        public bool IsOpenForEditing(string absoluteFilePath) => false;
    }

    private sealed class UnknownProbe : IEditorDocumentStateProbe
    {
        public EditorDocumentState GetDocumentState(string absoluteFilePath) => EditorDocumentState.Unknown;
    }

    private static readonly Doc AsmNewVersion = Asm with { Fv = "fv_asm_new", Version = 5, Bytes = Encoding.UTF8.GetBytes("assembly-payload-version-5") };

    private static HttpResponseMessage Content(Doc d) => new(HttpStatusCode.OK) { Content = new ByteArrayContent(d.Bytes) };

    private static HttpResponseMessage Available => FakeHttpHandler.Json(HttpStatusCode.OK, AvailableJson);

    private static WorkspaceMaterializer With(IEditorDocumentStateProbe? probe) => new(probe);

    private void AssertNoFileVersionRequests(FakeHttpHandler handler) =>
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));

    // ---- M-1: stale replacement under an open document ---------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_open_document_blocks_stale_replacement_before_any_download()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPartNewVersion, AvailableJson);

        var report = await Run(handler, "PRT-1", materializer: With(new ScriptedProbe(_ => true)));

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, result.Reason);
        Assert.Contains("close this document in Inventor", result.Reason);
        await unchanged();
        AssertNoFileVersionRequests(handler);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_document_opened_during_the_download_blocks_the_replacement()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new ScriptedProbe(call => call > 1);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        Assert.Equal(2, probe.Calls);
        await unchanged();
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_probe_that_fails_counts_as_open()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPartNewVersion, AvailableJson);

        var report = await Run(handler, "PRT-1", materializer: With(new ScriptedProbe(_ => throw new InvalidOperationException("Inventor is busy"))));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
        AssertNoFileVersionRequests(handler);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_probe_that_fails_during_the_recheck_counts_as_open()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new ScriptedProbe(call => call > 1 ? throw new InvalidOperationException("Inventor is busy") : false);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task No_probe_counts_as_open()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(null));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task A_file_another_process_holds_blocks_replacement_even_if_the_editor_says_closed(bool readOnly)
    {
        await CheckedOutPart();
        if (readOnly)
        {
            File.SetAttributes(PartPath, FileAttributes.ReadOnly);
        }
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPartNewVersion, AvailableJson);

        MaterializationReport report;
        using (new FileStream(PartPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            report = await Run(handler, "PRT-1");
        }

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
        AssertNoFileVersionRequests(handler);
    }

    // ---- M-1: read-only under an open document ------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_open_document_is_not_made_read_only_when_its_stale_marker_is_cleared()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1", materializer: With(new ScriptedProbe(_ => true)));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_document_opened_while_hashing_is_not_made_read_only()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new ScriptedProbe(call => call > 1);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_open_document_with_a_missing_file_is_not_restored_when_its_marker_is_stale()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPart, AvailableJson);

        var report = await Run(handler, "PRT-1", materializer: With(new ScriptedProbe(_ => true)));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
        AssertNoFileVersionRequests(handler);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_open_document_with_modified_bytes_changes_nothing()
    {
        await CheckedOutPart();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1", materializer: With(new ScriptedProbe(_ => true)));

        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        await unchanged();
    }

    // ---- what the probe must NOT affect -------------------------------------

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_valid_checkout_open_in_the_editor_is_never_asked_about_and_stays_usable()
    {
        await CheckedOutPart();
        var probe = new ScriptedProbe(_ => true);

        var report = await Run(Server(RootPart), "PRT-1", materializer: With(probe));

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(0, probe.Calls);
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task An_ordinary_controlled_file_is_never_asked_about()
    {
        await Run(Server(RootPart), "PRT-1");
        var probe = new ScriptedProbe(_ => true);

        var report = await Run(Server(RootPart), "PRT-1", materializer: With(probe));

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Equal(0, probe.Calls);
    }

    // ---- M-1: production wiring ---------------------------------------------

    private Task<MaterializationReport> RunThroughApiClient(FakeHttpHandler handler, IEditorDocumentProbe? probe) =>
        new ArchApiClient(WorkspaceTestSession.Server, new HttpClient(handler), new ArchApiClientOptions { EditorProbe = probe }).GetLatestAsync(
            WorkspaceTestSession.Make(),
            new GetLatestRequest { Root = CadDocumentLookup.ByNumber("PRT-1"), WorkspaceRoot = _root });

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_production_client_passes_its_editor_probe_to_the_materializer()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new ScriptedProbe(_ => true);

        var report = await RunThroughApiClient(ServerAnswering(RootPartNewVersion, AvailableJson), probe);

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        Assert.Equal(1, probe.Calls);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_unknown_editor_state_counts_as_open()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(new UnknownProbe()));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_production_client_treats_a_probe_that_cannot_say_unknown_as_unknown()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await RunThroughApiClient(ServerAnswering(RootPartNewVersion, AvailableJson), new PlainProbe());

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_production_client_with_no_probe_does_not_assume_the_document_is_closed()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await RunThroughApiClient(ServerAnswering(RootPartNewVersion, AvailableJson), probe: null);

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_production_client_replaces_a_stale_base_when_the_document_is_closed()
    {
        await CheckedOutPart();

        var report = await RunThroughApiClient(ServerAnswering(RootPartNewVersion, AvailableJson), NoEditorProbe.Instance);

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
    }

    // ---- M-2: the documented limit -------------------------------------------

    [Theory]
    [Trait("PackageC", "KnownLimit")]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Today_Check_In_or_Undo_on_a_stale_marker_leaves_a_file_Get_Latest_will_not_update(bool checkIn)
    {
        await CheckedOutPart();
        var staleServer = ServerAnswering(RootPartNewVersion, AvailableJson);
        var checkout = new CheckoutOrchestrator(WorkspaceTestSession.Server, WorkspaceTestSession.Make(), new HttpClient(staleServer));

        await Assert.ThrowsAsync<StaleCheckoutException>(() => checkIn
            ? checkout.CheckInAsync(_root, PartPath)
            : checkout.UndoAsync(_root, PartPath, reason: null));

        Assert.Null(Entry(PartPath).Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Unverified, Entry(PartPath).State);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Contains("local-conflict", result.Reason);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(LocalCheckoutState.Unverified, CheckoutStateMachine.Evaluate(Entry(PartPath), fileExists: true));
    }

    // ---- cancellation between entries ----------------------------------------

    private async Task<string> TwoStaleCheckouts()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        var asmPath = Path.Combine(_root, "asm.iam");
        CheckOutLocally(asmPath, Asm);
        CheckOutLocally(PartPath, DependencyPart);
        return asmPath;
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_cancelled_run_records_the_entry_it_finished_and_leaves_the_next_as_it_was()
    {
        var asmPath = await TwoStaleCheckouts();
        File.Delete(PartPath);
        var partUnchanged = await ExpectUnchanged(PartPath);
        using var cancel = new CancellationTokenSource();
        var handler = Server([AsmNewVersion, DependencyPart], _ => Available, content: d =>
        {
            if (d.Id == "cad_part")
            {
                cancel.Cancel();
            }
            return Content(d);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(handler, "ASM-1", ct: cancel.Token));

        Assert.Equal(AsmNewVersion.Bytes, await File.ReadAllBytesAsync(asmPath));
        Assert.True(ManagedFileGuard.IsControlled(asmPath));
        var asm = Entry(asmPath);
        Assert.Null(asm.Checkout);
        Assert.Equal("fv_asm_new", asm.FileVersionId);
        Assert.Equal(WorkspaceManifestEntryState.Verified, asm.State);
        await partUnchanged();
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_run_cancelled_between_entries_stops_there_and_records_what_it_finished()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        var asmPath = Path.Combine(_root, "asm.iam");
        CheckOutLocally(asmPath, Asm);
        CheckOutLocally(PartPath, DependencyPart);
        File.Delete(PartPath);
        using var cancel = new CancellationTokenSource();
        var cancelling = new WorkspaceMaterializer(NoEditorProbe.Instance, setWritable: path =>
        {
            cancel.Cancel();
            return ManagedFileGuard.SetWritable(path);
        });

        var ex = await Assert.ThrowsAsync<MaterializationCanceledException>(() => Run(
            Server([Asm, DependencyPart], path => FakeHttpHandler.Json(HttpStatusCode.OK, MineJson(path.Contains("cad_part", StringComparison.Ordinal) ? DependencyPart : Asm))),
            "ASM-1", ct: cancel.Token, materializer: cancelling));

        Assert.Equal("asm.iam", Assert.Single(ex.Completed.Results).RelativePath);
        Assert.False(File.Exists(PartPath), "the second entry never started");
        Assert.Equal(Binding(Asm), Entry(asmPath).Checkout);
        Assert.Equal(Binding(DependencyPart), Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_run_cancelled_before_it_changed_anything_leaves_the_manifest_untouched()
    {
        await TwoStaleCheckouts();
        var before = await File.ReadAllBytesAsync(ManifestPath);
        using var cancel = new CancellationTokenSource();
        var handler = Server([AsmNewVersion, DependencyPart], _ => Available, content: d =>
        {
            cancel.Cancel();
            return Content(d);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(handler, "ASM-1", ct: cancel.Token));

        Assert.Equal(before, await File.ReadAllBytesAsync(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_rerun_after_cancellation_finishes_the_work()
    {
        var asmPath = await TwoStaleCheckouts();
        using var cancel = new CancellationTokenSource();
        File.Delete(PartPath);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Run(Server([AsmNewVersion, DependencyPart], _ => Available, content: d =>
        {
            if (d.Id == "cad_part")
            {
                cancel.Cancel();
            }
            return Content(d);
        }), "ASM-1", ct: cancel.Token));

        var report = await Run(Server([AsmNewVersion, DependencyPart], _ => Available), "ASM-1");

        Assert.True(report.ReachedValidState);
        Assert.Null(Entry(asmPath).Checkout);
        Assert.Null(Entry(PartPath).Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_cancelled_run_that_cannot_record_its_work_says_so_instead_of_only_cancelling()
    {
        var asmPath = await TwoStaleCheckouts();
        File.Delete(PartPath);
        using var cancel = new CancellationTokenSource();
        FileStream? holder = null;
        var handler = Server([AsmNewVersion, DependencyPart], _ => Available, content: d =>
        {
            if (d.Id == "cad_part")
            {
                holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None);
                cancel.Cancel();
            }
            return Content(d);
        });

        try
        {
            var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "ASM-1", ct: cancel.Token));
            Assert.Contains("could not be saved", ex.Message);
        }
        finally
        {
            holder?.Dispose();
        }

        // Recoverable: the record still says what it said, and the rerun converges.
        Assert.NotNull(Entry(asmPath).Checkout);
        var report = await Run(Server([AsmNewVersion, DependencyPart], _ => Available), "ASM-1");
        Assert.True(report.ReachedValidState);
        Assert.Null(Entry(asmPath).Checkout);
    }

    // ---- save failure after a stale operation: state stays recoverable --------

    private async Task WithManifestHeldDuringRun(Doc plan)
    {
        FileStream? holder = null;
        var handler = Server([plan], _ => Available);
        try
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1",
                clock: OnRecording(() => holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None))));
        }
        finally
        {
            holder?.Dispose();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_failure_after_clearing_a_stale_marker_leaves_a_recoverable_state()
    {
        await CheckedOutPart();
        var manifestBefore = await File.ReadAllBytesAsync(ManifestPath);

        await WithManifestHeldDuringRun(RootPart);

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(manifestBefore, await File.ReadAllBytesAsync(ManifestPath));

        await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1");

        Assert.Null(Entry(PartPath).Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(WorkspaceManifestEntryState.Verified, Entry(PartPath).State);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_failure_after_replacing_a_stale_base_leaves_a_recoverable_state()
    {
        await CheckedOutPart();
        var manifestBefore = await File.ReadAllBytesAsync(ManifestPath);

        await WithManifestHeldDuringRun(RootPartNewVersion);

        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(manifestBefore, await File.ReadAllBytesAsync(ManifestPath));

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Null(Entry(PartPath).Checkout);
        Assert.Equal("fv_part_new", Entry(PartPath).FileVersionId);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_save_failure_after_restoring_a_valid_checkout_leaves_a_recoverable_state()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var manifestBefore = await File.ReadAllBytesAsync(ManifestPath);
        FileStream? holder = null;
        var handler = Server([RootPart], content: d =>
        {
            holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None);
            return Content(d);
        });

        try
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));
        }
        finally
        {
            holder?.Dispose();
        }

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(manifestBefore, await File.ReadAllBytesAsync(ManifestPath));

        await Run(Server(RootPart), "PRT-1");

        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
    }

    // ---- recovery messages ----------------------------------------------------

    public static TheoryData<string> RecoveryMessages => new()
    {
        GetLatestCheckoutPolicy.StaleConflictReason,
        GetLatestCheckoutPolicy.CheckoutWithoutRecordReason,
        GetLatestCheckoutPolicy.DocumentOpenReason,
        GetLatestCheckoutPolicy.PathConflictReason,
    };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(RecoveryMessages))]
    public void A_recovery_message_never_suggests_deleting_or_overwriting_a_file(string message)
    {
        Assert.DoesNotContain("delete", message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("remove", message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("overwrite", message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData(GetLatestCheckoutPolicy.StaleConflictReason)]
    [InlineData(GetLatestCheckoutPolicy.CheckoutWithoutRecordReason)]
    public void A_message_about_local_changes_says_to_keep_them_first(string message)
    {
        Assert.Contains("Copy this file to a safe place", message);
        Assert.True(
            message.IndexOf("Copy this file", StringComparison.Ordinal) < message.IndexOf("run Get Latest", StringComparison.Ordinal),
            "preserving the file comes before any next step");
    }
}
