using System.Net;
using System.Text;
using System.Text.Json;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Session;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>
/// P6 M4.4 Package C: what a Get Latest does to a file this user holds checked
/// out. Temp folders and fake HTTP only.
/// Trait PackageC=Defect   - the original failing tests against commit 9716692.
/// Trait PackageC=Policy   - the approved block / preserve / reconcile rules.
/// Trait PackageC=Baseline - safe behaviour that must not regress.
/// </summary>
public partial class GetLatestCheckoutConsistencyTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "arch-cc-pkgc-" + Guid.NewGuid().ToString("N"));

    public GetLatestCheckoutConsistencyTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try
        {
            foreach (var f in Directory.GetFiles(_root, "*", SearchOption.AllDirectories))
                File.SetAttributes(f, FileAttributes.Normal);
            Directory.Delete(_root, recursive: true);
        }
        catch { /* best effort */ }
    }

    private sealed record Doc(string Id, string Number, string FileName, string CadType, string Fv, int Version, byte[] Bytes, bool IsRoot, params string[] DependsOn)
    {
        public bool CanMaterialize { get; init; } = true;
    }

    private static readonly byte[] AsmBytes = Encoding.UTF8.GetBytes("assembly-payload-1");
    private static readonly byte[] PartBytes = Encoding.UTF8.GetBytes("part-payload-longer-2");
    private static readonly byte[] NewPartBytes = Encoding.UTF8.GetBytes("part-payload-version-3-is-newer");
    private static readonly byte[] EditedBytes = Encoding.UTF8.GetBytes("saved user edits");

    private static readonly Doc Asm = new("cad_root", "ASM-1", "asm.iam", "IAM", "fv_asm", 4, AsmBytes, true, "cad_part");
    private static readonly Doc DependencyPart = new("cad_part", "PRT-1", "part.ipt", "IPT", "fv_part", 2, PartBytes, false);
    private static readonly Doc RootPart = DependencyPart with { IsRoot = true };
    private static readonly Doc RootPartNewVersion = RootPart with { Fv = "fv_part_new", Version = 3, Bytes = NewPartBytes };
    private static readonly Doc Other = new("cad_other", "OTH-1", "other.ipt", "IPT", "fv_other", 1, Encoding.UTF8.GetBytes("other-bytes"), true);

    private const string AvailableJson = """{"state":"available"}""";
    private const string LockedJson = """{"state":"locked","checkout":{"id":"co_9","cadDocumentId":"cad_part","baseFileVersionId":"fv_part","baseVersionNumber":2,"checkedOutById":"u2","checkedOutAt":"2026-10-30T12:00:00.000Z","checkedOutBy":{"name":"Sam"}}}""";

    private string PartPath => Path.Combine(_root, "part.ipt");

    private string ManifestPath => Path.Combine(_root, WorkspaceManifest.RelativeManifestPath);

    private static string Sha(byte[] b) => FakeContentDownloader.Sha256Hex(b);

    private static string MineJson(Doc baseDoc, string checkoutId = "co_1") => JsonSerializer.Serialize(new
    {
        state = "mine",
        checkout = new
        {
            id = checkoutId,
            cadDocumentId = baseDoc.Id,
            baseFileVersionId = baseDoc.Fv,
            baseVersionNumber = baseDoc.Version,
            checkedOutById = "u1",
            checkedOutAt = "2026-10-30T12:00:00.000Z",
        },
    });

    private static string PlanJson(params Doc[] docs)
    {
        var entries = docs.Select(d => new
        {
            cadDocumentId = d.Id,
            documentNumber = d.Number,
            fileName = d.FileName,
            cadType = d.CadType,
            isRoot = d.IsRoot,
            placement = new { generatedRelativePath = d.FileName },
            dependsOn = d.DependsOn.Select(c => new { cadDocumentId = c, dependencyType = "COMPONENT" }).ToArray(),
            canMaterialize = d.CanMaterialize,
            blockedReasons = Array.Empty<string>(),
            version = new
            {
                fileVersionId = d.Fv,
                versionNumber = d.Version,
                checksum = Sha(d.Bytes),
                fileSize = d.Bytes.Length,
                originalFileName = d.FileName,
                contentPath = $"/api/file-versions/{d.Fv}/content",
            },
        }).ToArray();
        return JsonSerializer.Serialize(new
        {
            contract = new { id = "arch-plm.cad-workspace-plan", version = "1.0.0" },
            root = new { cadDocumentId = docs[0].Id },
            generatedAt = "2026-10-30T00:00:00Z",
            documentCount = docs.Length,
            safe = true,
            entries,
            problems = Array.Empty<object>(),
            traversal = new { visitedCount = docs.Length, edgeCount = 0, maxNodes = 5000 },
        });
    }

    /// <summary>The fake server. <paramref name="status"/> answers
    ///  <c>GET …/checkout</c>; by default the part is the caller's, on its plan
    ///  version.</summary>
    private FakeHttpHandler Server(Doc[] docs, Func<string, HttpResponseMessage>? status = null, Func<Doc, HttpResponseMessage>? content = null, Action? onPlan = null, bool serveOlderVersions = true) => new(req =>
    {
        var path = req.RequestUri!.AbsolutePath;
        if (path == "/api/desktop/cad-documents/resolve")
        {
            var root = docs[0];
            return FakeHttpHandler.Json(HttpStatusCode.OK, JsonSerializer.Serialize(new
            {
                contract = "arch-plm.desktop-cad-document.v1",
                cadDocumentId = root.Id,
                documentNumber = root.Number,
                fileName = root.FileName,
                cadType = root.CadType,
            }));
        }
        if (path == $"/api/cad-documents/{docs[0].Id}/workspace-plan")
        {
            onPlan?.Invoke();
            return FakeHttpHandler.Json(HttpStatusCode.OK, PlanJson(docs));
        }
        if (path.EndsWith("/checkout", StringComparison.Ordinal))
        {
            return status?.Invoke(path) ?? FakeHttpHandler.Json(HttpStatusCode.OK, DefaultStatus(docs.First(d => path.Contains(d.Id, StringComparison.Ordinal))));
        }
        foreach (var d in docs)
        {
            if (path == $"/api/file-versions/{d.Fv}/content")
            {
                return content?.Invoke(d) ?? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(d.Bytes) };
            }
        }
        if (serveOlderVersions && path == $"/api/file-versions/{RootPart.Fv}/content")
        {
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(PartBytes) };
        }
        if (serveOlderVersions && path == $"/api/file-versions/{Asm.Fv}/content")
        {
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(AsmBytes) };
        }
        return FakeHttpHandler.Json(HttpStatusCode.NotFound, """{"error":"no route"}""");
    });

    /// <summary>By default the server agrees with the workspace: a document with
    ///  a marker is the caller's checkout, and one without is nobody's.</summary>
    private string DefaultStatus(Doc doc) =>
        WorkspaceManifest.LoadOrEmpty(_root).Entries.Any(e => e.CadDocumentId == doc.Id && e.Checkout is not null) ? MineJson(doc) : AvailableJson;

    private FakeHttpHandler Server(params Doc[] docs) => Server(docs, status: null);

    private FakeHttpHandler ServerAnswering(Doc doc, string statusJson, HttpStatusCode code = HttpStatusCode.OK) =>
        Server([doc], _ => FakeHttpHandler.Json(code, statusJson));

    private Task<MaterializationReport> Run(FakeHttpHandler handler, string documentNumber, bool withStatusClient = true, CancellationToken ct = default, WorkspaceMaterializer? materializer = null, Func<DateTimeOffset>? clock = null, Func<WorkspaceManifest, string?>? saveManifest = null, TimeSpan? statusDeadline = null)
    {
        var http = new HttpClient(handler);
        var orchestrator = new GetLatestOrchestrator(
            new GetLatestTestHooks(saveManifest, statusDeadline),
            WorkspaceTestSession.Server,
            resolve: (s, lu, c) => GetLatestOrchestrator.ResolveViaHttpAsync(WorkspaceTestSession.Server, s, http, lu, TimeSpan.FromSeconds(5), c),
            planClientFactory: s => new WorkspacePlanClient(WorkspaceTestSession.Server, s, http, TimeSpan.FromSeconds(5)),
            downloaderFactory: s => new HttpContentDownloader(WorkspaceTestSession.Server, s, http),
            materializer: materializer ?? new WorkspaceMaterializer(NoEditorProbe.Instance),
            clock: clock,
            checkoutStatus: withStatusClient
                ? (s, id, c) => new CheckoutHttpClient(WorkspaceTestSession.Server, s, http, TimeSpan.FromSeconds(5)).GetStatusStrictAsync(id, c)
                : null);
        return orchestrator.RunAsync(WorkspaceTestSession.Make(),
            new GetLatestRequest { Root = CadDocumentLookup.ByNumber(documentNumber), WorkspaceRoot = _root }, ct);
    }

    private static WorkspaceCheckoutBinding Binding(Doc baseDoc) => new()
    {
        CheckoutId = "co_1",
        BaseFileVersionId = baseDoc.Fv,
        BaseVersionNumber = baseDoc.Version,
        BaseChecksum = Sha(baseDoc.Bytes),
        BaseFileSize = baseDoc.Bytes.Length,
        CheckedOutAtUtc = new DateTimeOffset(2026, 10, 30, 12, 0, 0, TimeSpan.Zero),
    };

    /// <summary>Exactly what <c>CheckoutOrchestrator.CheckoutAsync</c> leaves
    ///  behind: the manifest marker, then a writable file.</summary>
    private void CheckOutLocally(string absolutePath, Doc baseDoc)
    {
        Assert.True(WorkspaceManifest.LoadOrEmpty(_root).MarkCheckedOut(absolutePath, Binding(baseDoc)));
        Assert.True(ManagedFileGuard.SetWritable(absolutePath));
    }

    private async Task CheckedOutPart()
    {
        await Run(Server(RootPart), "PRT-1");
        CheckOutLocally(PartPath, RootPart);
    }

    private WorkspaceManifestEntry Entry(string absolutePath)
    {
        var entry = WorkspaceManifest.LoadOrEmpty(_root).FindByAbsolutePath(absolutePath);
        Assert.NotNull(entry);
        return entry!;
    }

    private static void AssertOnlyReads(FakeHttpHandler handler, int expectedCount, int expectedStatusReads)
    {
        Assert.Equal(expectedCount, handler.Requests.Count);
        Assert.All(handler.Requests, r => Assert.Equal(HttpMethod.Get, r.Method));
        Assert.Equal(expectedStatusReads, handler.Requests.Count(r => r.RequestUri!.AbsolutePath.EndsWith("/checkout", StringComparison.Ordinal)));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.Contains("/checkin", StringComparison.Ordinal));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.Contains("/undo", StringComparison.Ordinal));
    }

    /// <summary>A snapshot of everything a blocked entry must leave alone.</summary>
    private async Task<Func<Task>> ExpectUnchanged(string absolutePath)
    {
        var entry = JsonSerializer.Serialize(Entry(absolutePath));
        var exists = File.Exists(absolutePath);
        var bytes = exists ? await File.ReadAllBytesAsync(absolutePath) : null;
        var controlled = ManagedFileGuard.IsControlled(absolutePath);
        return async () =>
        {
            Assert.Equal(entry, JsonSerializer.Serialize(Entry(absolutePath)));
            Assert.Equal(exists, File.Exists(absolutePath));
            Assert.Equal(controlled, ManagedFileGuard.IsControlled(absolutePath));
            if (exists)
            {
                Assert.Equal(bytes, await File.ReadAllBytesAsync(absolutePath));
            }
        };
    }

    // ---- active checkout, unchanged bytes (AlreadyCurrent) ---------------

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task AlreadyCurrent_keeps_the_checkout_marker()
    {
        await CheckedOutPart();

        var report = await Run(Server(RootPart), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task AlreadyCurrent_leaves_a_checked_out_file_writable()
    {
        await CheckedOutPart();

        await Run(Server(RootPart), "PRT-1");

        Assert.False(ManagedFileGuard.IsControlled(PartPath), "a checked-out file must stay writable");
    }

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task A_checked_out_dependency_in_a_root_run_keeps_its_marker_and_stays_writable()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        CheckOutLocally(PartPath, DependencyPart);

        var report = await Run(Server(Asm, DependencyPart), "ASM-1");

        Assert.Equal(2, report.Summary.AlreadyCurrent);
        Assert.Equal(Binding(DependencyPart), Entry(PartPath).Checkout);
        Assert.False(ManagedFileGuard.IsControlled(PartPath), "a checked-out dependency must stay writable");
    }

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task Marker_and_read_only_attribute_stay_consistent_for_the_checked_out_file()
    {
        await CheckedOutPart();

        await Run(Server(RootPart), "PRT-1");

        Assert.Equal(Entry(PartPath).Checkout is not null, !ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(LocalCheckoutState.CheckedOutByMe, CheckoutStateMachine.Evaluate(Entry(PartPath), fileExists: true));
    }

    // ---- active checkout, file missing (Downloaded) ----------------------

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task Downloaded_over_a_missing_checked_out_file_keeps_the_marker()
    {
        await CheckedOutPart();
        File.Delete(PartPath);

        var report = await Run(Server(RootPart), "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task Downloaded_over_a_missing_checked_out_file_leaves_it_writable()
    {
        await CheckedOutPart();
        File.Delete(PartPath);

        await Run(Server(RootPart), "PRT-1");

        Assert.False(ManagedFileGuard.IsControlled(PartPath), "a restored checked-out file must stay writable");
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.NotFound)]
    public async Task A_valid_checkout_whose_base_cannot_be_downloaded_is_left_exactly_as_it_was(HttpStatusCode code)
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server([RootPart], content: _ => FakeHttpHandler.Json(code, "{}")), "PRT-1");

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_valid_checkout_whose_restored_bytes_fail_verification_is_left_exactly_as_it_was()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var wrongBytes = new byte[PartBytes.Length];

        var report = await Run(Server([RootPart], content: _ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(wrongBytes) }), "PRT-1");

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
    }

    // ---- unreadable or invalid manifest: refused -------------------------

    [Theory]
    [Trait("PackageC", "Defect")]
    [InlineData("{ this is not json")]
    [InlineData("")]
    [InlineData("""{"schema":"some.other.schema.v9","entries":[]}""")]
    public async Task An_invalid_manifest_must_not_change_the_read_only_attribute_of_an_existing_file(string content)
    {
        await CheckedOutPart();
        await File.WriteAllTextAsync(ManifestPath, content);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.False(ManagedFileGuard.IsControlled(PartPath), "without a readable manifest the checkout state is unknown");
        Assert.Equal(content, await File.ReadAllTextAsync(ManifestPath));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    [Trait("PackageC", "Defect")]
    public async Task A_locked_manifest_must_not_change_the_read_only_attribute_of_an_existing_file()
    {
        await CheckedOutPart();
        var handler = Server(RootPart);

        using (new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));
        }

        Assert.False(ManagedFileGuard.IsControlled(PartPath), "without a readable manifest the checkout state is unknown");
        Assert.Empty(handler.Requests);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_invalid_manifest_changes_no_file_even_outside_the_plan()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        CheckOutLocally(PartPath, DependencyPart);
        await File.WriteAllTextAsync(ManifestPath, "{ this is not json");

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(Other), "OTH-1"));

        Assert.False(File.Exists(Path.Combine(_root, "other.ipt")));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal("{ this is not json", await File.ReadAllTextAsync(ManifestPath));
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_locked_manifest_keeps_its_saved_checkout_marker()
    {
        await CheckedOutPart();

        using (new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPart), "PRT-1"));
        }

        Assert.Equal(Binding(RootPart), Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public void Load_tells_a_missing_manifest_from_an_invalid_one()
    {
        Assert.Equal(WorkspaceManifestLoadStatus.Missing, WorkspaceManifest.Load(_root).Status);

        Directory.CreateDirectory(Path.GetDirectoryName(ManifestPath)!);
        File.WriteAllText(ManifestPath, "{ this is not json");
        Assert.Equal(WorkspaceManifestLoadStatus.Invalid, WorkspaceManifest.Load(_root).Status);
        Assert.Empty(WorkspaceManifest.LoadOrEmpty(_root).Entries);

        File.Delete(ManifestPath);
        WorkspaceManifest.LoadOrEmpty(_root).SaveAtomic();
        Assert.Equal(WorkspaceManifestLoadStatus.Loaded, WorkspaceManifest.Load(_root).Status);
    }

    // ---- status unavailable, ambiguous or unauthorized: blocked -----------

    public static TheoryData<HttpStatusCode, string> UnusableStatusAnswers => new()
    {
        { HttpStatusCode.InternalServerError, "{}" },
        { HttpStatusCode.Unauthorized, """{"error":"Your session is not valid."}""" },
        { HttpStatusCode.Forbidden, "{}" },
        { HttpStatusCode.NotFound, "{}" },
        { HttpStatusCode.OK, "{ this is not json" },
        { HttpStatusCode.OK, """{"state":"something-new"}""" },
        { HttpStatusCode.OK, """{}""" },
        { HttpStatusCode.OK, """{"state":"mine"}""" },
        { HttpStatusCode.OK, """{"state":"mine","checkout":{"id":"co_1","cadDocumentId":"cad_part"}}""" },
        { HttpStatusCode.OK, """{"state":"mine","checkout":{"id":"co_1","cadDocumentId":"cad_WRONG","baseFileVersionId":"fv_part","baseVersionNumber":2}}""" },
        { HttpStatusCode.OK, """{"state":"locked"}""" },
        { HttpStatusCode.OK, """{"state":"locked","checkout":{"id":"co_9","cadDocumentId":"cad_WRONG","baseFileVersionId":"fv_part","baseVersionNumber":2}}""" },
    };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(UnusableStatusAnswers))]
    public async Task An_unusable_status_answer_blocks_and_changes_nothing(HttpStatusCode code, string body)
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, body, code), "PRT-1");

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, result.Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_unreachable_server_blocks_a_missing_checked_out_file_without_restoring_it()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = Server([RootPart], _ => throw new HttpRequestException("unreachable"));

        var report = await Run(handler, "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, report.Results.Single().Reason);
        await unchanged();
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task No_status_client_blocks_a_checked_out_entry()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server(RootPart), "PRT-1", withStatusClient: false);

        Assert.Equal(GetLatestCheckoutPolicy.StatusUnknownReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_during_the_status_read_propagates_and_changes_nothing()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        using var cancel = new CancellationTokenSource();
        var http = new HttpClient(Server(RootPart));
        var orchestrator = new GetLatestOrchestrator(
            new GetLatestTestHooks(),
            WorkspaceTestSession.Server,
            resolve: (s, lu, c) => GetLatestOrchestrator.ResolveViaHttpAsync(WorkspaceTestSession.Server, s, http, lu, TimeSpan.FromSeconds(5), c),
            planClientFactory: s => new WorkspacePlanClient(WorkspaceTestSession.Server, s, http, TimeSpan.FromSeconds(5)),
            downloaderFactory: s => new HttpContentDownloader(WorkspaceTestSession.Server, s, http),
            checkoutStatus: (_, _, c) =>
            {
                cancel.Cancel();
                c.ThrowIfCancellationRequested();
                throw new InvalidOperationException("not reached");
            });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => orchestrator.RunAsync(WorkspaceTestSession.Make(),
            new GetLatestRequest { Root = CadDocumentLookup.ByNumber("PRT-1"), WorkspaceRoot = _root }, cancel.Token));

        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task The_status_read_used_by_Check_In_and_Undo_still_reads_an_unknown_state_as_available()
    {
        var handler = new FakeHttpHandler(_ => FakeHttpHandler.Json(HttpStatusCode.OK, """{"state":"something-new"}"""));
        var client = new CheckoutHttpClient(WorkspaceTestSession.Server, WorkspaceTestSession.Make(), new HttpClient(handler));

        var status = await client.GetStatusAsync("cad_part");

        Assert.Equal(ServerCheckoutState.Available, status.State);
    }

    // ---- server proves the marker stale -----------------------------------

    public static TheoryData<string> StaleAnswers => new() { AvailableJson, LockedJson };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(StaleAnswers))]
    public async Task A_stale_marker_over_unchanged_bytes_is_removed_and_the_file_controlled(string staleAnswer)
    {
        await CheckedOutPart();

        var report = await Run(ServerAnswering(RootPart, staleAnswer), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Null(Entry(PartPath).Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Verified, Entry(PartPath).State);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(StaleAnswers))]
    public async Task A_stale_marker_over_a_missing_file_is_removed_and_the_file_downloaded_read_only(string staleAnswer)
    {
        await CheckedOutPart();
        File.Delete(PartPath);

        var report = await Run(ServerAnswering(RootPart, staleAnswer), "PRT-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single().Status);
        Assert.Null(Entry(PartPath).Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(StaleAnswers))]
    public async Task A_stale_marker_over_modified_bytes_blocks_and_changes_nothing(string staleAnswer)
    {
        await CheckedOutPart();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, staleAnswer), "PRT-1");

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Equal(GetLatestCheckoutPolicy.StaleConflictReason, result.Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_stale_marker_over_the_plan_version_is_removed()
    {
        await CheckedOutPart();
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Null(Entry(PartPath).Checkout);
        Assert.Equal("fv_part_new", Entry(PartPath).FileVersionId);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    // ---- server says mine, but versions disagree: blocked -----------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_valid_checkout_with_a_newer_plan_version_blocks_and_changes_nothing()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPartNewVersion, MineJson(RootPart)), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.BaseMismatchReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_server_base_that_differs_from_the_marker_blocks_and_changes_nothing()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPartNewVersion)), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.BaseMismatchReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_different_server_checkout_id_blocks_and_changes_nothing()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, MineJson(RootPart, checkoutId: "co_2")), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.BaseMismatchReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_plan_checksum_that_differs_from_the_marker_blocks_and_changes_nothing()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var sameIdsOtherBytes = RootPart with { Bytes = NewPartBytes };

        var report = await Run(ServerAnswering(sameIdsOtherBytes, MineJson(RootPart)), "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.BaseMismatchReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_missing_file_with_an_unproven_base_is_not_restored()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPartNewVersion, MineJson(RootPart));

        var report = await Run(handler, "PRT-1");

        Assert.Equal(GetLatestCheckoutPolicy.BaseMismatchReason, report.Results.Single().Reason);
        await unchanged();
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.AbsolutePath.StartsWith("/api/file-versions/", StringComparison.Ordinal));
    }

    // ---- several entries ---------------------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_blocked_entry_does_not_stop_the_others_or_lose_them()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        CheckOutLocally(PartPath, DependencyPart);
        var asmPath = Path.Combine(_root, "asm.iam");
        File.SetAttributes(asmPath, FileAttributes.Normal);
        File.Delete(asmPath);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(Server([Asm, DependencyPart], path => path.Contains("cad_part", StringComparison.Ordinal)
            ? FakeHttpHandler.Json(HttpStatusCode.InternalServerError, "{}")
            : Available), "ASM-1");

        Assert.Equal(MaterializationStatus.Downloaded, report.Results.Single(r => r.RelativePath == "asm.iam").Status);
        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single(r => r.RelativePath == "part.ipt").Status);
        Assert.Equal(WorkspaceManifestEntryState.Verified, Entry(asmPath).State);
        Assert.True(ManagedFileGuard.IsControlled(asmPath));
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Each_bound_entry_in_the_plan_gets_one_status_read_with_or_without_a_marker()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        CheckOutLocally(PartPath, DependencyPart);
        var handler = Server(Asm, DependencyPart);

        await Run(handler, "ASM-1");

        AssertOnlyReads(handler, expectedCount: 4, expectedStatusReads: 2);
        Assert.Contains(handler.Requests, r => r.RequestUri!.AbsolutePath == "/api/cad-documents/cad_part/checkout");
        Assert.Contains(handler.Requests, r => r.RequestUri!.AbsolutePath == "/api/cad-documents/cad_root/checkout");
    }

    // ---- behaviour that must not regress ---------------------------------

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_modified_checked_out_file_is_blocked_unchanged_and_keeps_its_marker()
    {
        await CheckedOutPart();
        await File.WriteAllBytesAsync(PartPath, EditedBytes);

        var report = await Run(Server(RootPart), "PRT-1");

        var result = report.Results.Single();
        Assert.Equal(MaterializationStatus.Blocked, result.Status);
        Assert.Contains("local-conflict", result.Reason);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        var entry = Entry(PartPath);
        Assert.Equal(Binding(RootPart), entry.Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Unverified, entry.State);
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task An_entry_outside_the_plan_is_untouched_with_its_marker_and_attribute()
    {
        await Run(Server(Asm, DependencyPart), "ASM-1");
        CheckOutLocally(PartPath, DependencyPart);
        var before = JsonSerializer.Serialize(Entry(PartPath));
        var handler = Server(Other);

        await Run(handler, "OTH-1");

        Assert.Equal(before, JsonSerializer.Serialize(Entry(PartPath)));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        AssertOnlyReads(handler, expectedCount: 3, expectedStatusReads: 0);
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_current_file_with_no_checkout_is_made_read_only_again()
    {
        await Run(Server(RootPart), "PRT-1");
        File.SetAttributes(PartPath, FileAttributes.Normal);

        await Run(Server(RootPart), "PRT-1");

        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Null(Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_run_over_a_current_checked_out_file_adds_only_its_status_read()
    {
        await CheckedOutPart();
        var handler = Server(RootPart);

        await Run(handler, "PRT-1");

        AssertOnlyReads(handler, expectedCount: 3, expectedStatusReads: 1);
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_run_over_a_missing_checked_out_file_adds_its_status_and_content_reads()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var handler = Server(RootPart);

        await Run(handler, "PRT-1");

        AssertOnlyReads(handler, expectedCount: 4, expectedStatusReads: 1);
    }
}
