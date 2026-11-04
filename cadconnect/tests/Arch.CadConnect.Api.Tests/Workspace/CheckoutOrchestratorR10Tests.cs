using System.Net;
using System.Text.Json.Nodes;

using Arch.CadConnect.Api;
using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;
using Arch.CadConnect.Core.Workspace.Locking;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R10: a direct caller of the orchestrator gets the
///  same guards as the add-in, a marker is only ever restored from what the server
///  confirmed through its authorizing POST, and nothing automatic releases a
///  checkout.</summary>
public partial class CheckoutOrchestratorTests
{
    private const string Op = "0123456789abcdef0123456789abcdef";

    public static TheoryData<string> Commands => new() { "Checkout", "CheckIn", "Undo" };

    private Task Invoke(CheckoutOrchestrator orchestrator, string command) => command switch
    {
        "Checkout" => orchestrator.CheckoutAsync(_root, PartPath),
        "CheckIn" => orchestrator.CheckInAsync(_root, PartPath),
        _ => orchestrator.UndoAsync(_root, PartPath, reason: null),
    };

    private void EditManifest(Action<JsonObject> edit)
    {
        var manifest = JsonNode.Parse(File.ReadAllText(ManifestPath))!.AsObject();
        edit(manifest);
        File.WriteAllText(ManifestPath, manifest.ToJsonString());
    }

    private string[] AllFiles() => Directory
        .GetFiles(_root, "*", new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = 0 })
        .Where(f => !f.Contains(@"\.arch\locks\", StringComparison.OrdinalIgnoreCase))
        .Select(f => f + " " + Sha(File.ReadAllBytes(f)))
        .OrderBy(s => s, StringComparer.Ordinal)
        .ToArray();

    private static IEnumerable<HttpRequestMessage> Posts(FakeHttpHandler handler, string suffix) =>
        handler.Requests.Where(r => r.Method == HttpMethod.Post && r.RequestUri!.AbsolutePath.EndsWith(suffix, StringComparison.Ordinal));

    // ---- a direct caller is guarded before anything happens ------------------------

    public static TheoryData<string, string> Refusals
    {
        get
        {
            var data = new TheoryData<string, string>();
            foreach (var command in new[] { "Checkout", "CheckIn", "Undo" })
            {
                foreach (var refusal in new[] { "interrupted", "other server", "other organization", "another session's server" })
                {
                    data.Add(command, refusal);
                }
            }
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(Refusals))]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_caller_is_refused_with_nothing_sent_and_nothing_changed(string command, string refusal)
    {
        SeedControlled();
        await CheckoutFirst();
        var server = WorkspaceTestSession.Server;
        switch (refusal)
        {
            case "interrupted": File.Move(ManifestPath, $"{ManifestPath}.{Op}.previous"); break;
            case "other server": EditManifest(m => m["serverOrigin"] = "https://other.example.com"); break;
            case "other organization": EditManifest(m => m["organizationId"] = "org-of-someone-else"); break;
            default: server = Core.Session.ArchServerUri.Parse("https://other.example.com"); break;
        }
        var before = AllFiles();
        var handler = Server();
        var orchestrator = new CheckoutOrchestrator(server, WorkspaceTestSession.Make(), new HttpClient(handler), TimeSpan.FromSeconds(5));

        await Assert.ThrowsAnyAsync<Exception>(() => Invoke(orchestrator, command));

        Assert.Empty(handler.Requests);
        Assert.Equal(before, AllFiles());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_healthy_workspace_with_no_recorded_organization_keeps_working_directly()
    {
        SeedControlled();
        await CheckoutFirst();
        EditManifest(m => m.Remove("organizationId"));

        var result = await Orchestrator(Server()).CheckInAsync(_root, PartPath);

        Assert.True(result.Verified);
    }

    // ---- Check In needs the record of the checkout it completes --------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Check_In_without_a_marker_uploads_nothing_even_when_the_server_says_mine()
    {
        SeedControlled();
        var handler = Server(heldWithoutMarker: true);

        await Assert.ThrowsAsync<NotCheckedOutLocallyException>(() => Orchestrator(handler).CheckInAsync(_root, PartPath));

        Assert.Empty(Posts(handler, "/checkin"));
    }

    // ---- a malformed answer proves nothing about a marker ---------------------------

    public static TheoryData<string, string> MalformedStatuses
    {
        get
        {
            var data = new TheoryData<string, string>();
            foreach (var command in new[] { "CheckIn", "Undo" })
            {
                data.Add(command, """{"state":"something-new"}""");
                data.Add(command, """{"state":"available","checkout":{"id":"co_1","cadDocumentId":"cad_part"}}""");
                data.Add(command, """{"state":"locked"}""");
                data.Add(command, """{"state":"mine","checkout":{"id":" co_1","cadDocumentId":"cad_part","baseFileVersionId":"fv_1","baseVersionNumber":1,"checkedOutById":"u1","checkedOutAt":"2026-09-05T12:00:00.000Z"}}""");
                data.Add(command, """{"state":"mine","checkout":{"id":"co_1","cadDocumentId":"cad_part","baseFileVersionId":"fv_1","baseVersionNumber":1,"checkedOutById":"someone-else","checkedOutAt":"2026-09-05T12:00:00.000Z"}}""");
                data.Add(command, """{"state":"locked","checkout":{"id":"co_1","cadDocumentId":"cad_part","baseFileVersionId":"fv_1","baseVersionNumber":1,"checkedOutById":"u1","checkedOutAt":"2026-09-05T12:00:00.000Z"}}""");
            }
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(MalformedStatuses))]
    [Trait("PackageC", "Policy")]
    public async Task A_malformed_or_contradictory_status_keeps_the_marker(string command, string body)
    {
        SeedControlled();
        await CheckoutFirst();
        var marker = Entry().Checkout;
        var handler = new FakeHttpHandler(_ => Json(HttpStatusCode.OK, body));

        await Assert.ThrowsAnyAsync<Exception>(() => Invoke(Orchestrator(handler), command));

        Assert.Equal(marker, Entry().Checkout);
        Assert.Empty(Posts(handler, "/checkin"));
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Theory]
    [InlineData("CheckIn")]
    [InlineData("Undo")]
    [Trait("PackageC", "Policy")]
    public async Task A_valid_available_answer_still_reconciles_a_stale_marker(string command)
    {
        SeedControlled();
        await CheckoutFirst();

        await Assert.ThrowsAsync<StaleCheckoutException>(() => Invoke(Orchestrator(Server(statusState: "available")), command));

        Assert.Null(Entry().Checkout);
    }

    // ---- Checkout never locks what it cannot honour ---------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_workspace_behind_the_server_is_refused_before_the_POST()
    {
        SeedControlled();
        var handler = Server(statusState: "available", latestFileVersionId: "fv_2", latestVersion: 2);

        await Assert.ThrowsAnyAsync<Exception>(() => Orchestrator(handler).CheckoutAsync(_root, PartPath));

        Assert.Empty(Posts(handler, "/checkout"));
        Assert.Null(Entry().Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Theory]
    [InlineData("""{"error":"down"}""", HttpStatusCode.ServiceUnavailable)]
    [InlineData("""{"contract":"something-else","results":[]}""", HttpStatusCode.OK)]
    [Trait("PackageC", "Policy")]
    public async Task A_version_lookup_with_no_usable_answer_refuses_before_the_POST(string body, HttpStatusCode code)
    {
        SeedControlled();
        var handler = Server(statusState: "available", latestResponse: () => Json(code, body));

        await Assert.ThrowsAnyAsync<Exception>(() => Orchestrator(handler).CheckoutAsync(_root, PartPath));

        Assert.Empty(Posts(handler, "/checkout"));
    }

    [Theory]
    [InlineData(HttpStatusCode.Created, "created")]
    [InlineData(HttpStatusCode.OK, "already-mine")]
    [Trait("PackageC", "Policy")]
    public async Task A_POST_on_another_base_writes_nothing_and_releases_nothing(HttpStatusCode code, string status)
    {
        SeedControlled();
        var body = PostBody(status, baseFv: "fv_2", baseVersion: 2);
        var handler = Server(statusState: "available", checkoutStatus: code, checkoutBody: body);

        var result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);

        Assert.True(result.ReconcileNeeded);
        Assert.False(result.ManifestUpdated);
        Assert.False(result.MadeWritable);
        Assert.Null(Entry().Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Empty(Posts(handler, "/undo"));
    }

    public static TheoryData<HttpStatusCode, string> MalformedPosts => new()
    {
        { HttpStatusCode.Created, PostBody("something-new") },
        { HttpStatusCode.OK, PostBody("created") },
        { HttpStatusCode.Created, PostBody("already-mine") },
        { HttpStatusCode.Created, PostBody("created", id: "") },
        { HttpStatusCode.Created, PostBody("created", id: " co_1") },
        { HttpStatusCode.Created, PostBody("created", baseVersion: 0) },
        { HttpStatusCode.Created, PostBody("created", owner: "someone-else") },
        { HttpStatusCode.Created, PostBody("created", at: "yesterday") },
        { HttpStatusCode.Created, PostBody("created", at: "2026-09-05T12:00:00") },
        { HttpStatusCode.Created, "not json" },
    };

    [Theory]
    [MemberData(nameof(MalformedPosts))]
    [Trait("PackageC", "Policy")]
    public async Task A_malformed_POST_response_writes_nothing_and_says_the_checkout_may_be_held(HttpStatusCode code, string body)
    {
        SeedControlled();
        var handler = Server(statusState: "available", checkoutStatus: code, checkoutBody: body);

        var ex = await Assert.ThrowsAnyAsync<Exception>(() => Orchestrator(handler).CheckoutAsync(_root, PartPath));

        Assert.Contains("may", ex.Message);
        Assert.Null(Entry().Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_lost_POST_response_writes_nothing_and_the_retry_restores_the_marker()
    {
        SeedControlled();
        var lost = new FakeHttpHandler(req =>
        {
            if (req.Method == HttpMethod.Post)
            {
                throw new HttpRequestException("connection lost after the request was sent");
            }
            return Server(statusState: "available").Respond(req);
        });

        await Assert.ThrowsAnyAsync<Exception>(() => Orchestrator(lost).CheckoutAsync(_root, PartPath));

        Assert.Null(Entry().Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Empty(Posts(lost, "/undo"));

        var retry = await Orchestrator(Server(heldWithoutMarker: true)).CheckoutAsync(_root, PartPath);

        Assert.False(retry.ReconcileNeeded);
        Assert.Equal("co_1", Entry().Checkout!.CheckoutId);
    }

    // ---- restoring a marker from what the server confirmed ---------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_lost_marker_is_restored_from_the_POST_with_base_metadata_from_the_entry_only()
    {
        SeedControlled();
        var edited = "edited bytes that must not be hashed into a base"u8.ToArray();
        ManagedFileGuard.SetWritable(PartPath);
        File.WriteAllBytes(PartPath, edited);
        var handler = Server(heldWithoutMarker: true);

        var result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);

        var marker = Entry().Checkout!;
        Assert.False(result.ReconcileNeeded);
        Assert.Equal("co_1", marker.CheckoutId);
        Assert.Equal("fv_1", marker.BaseFileVersionId);
        Assert.Equal(1, marker.BaseVersionNumber);
        Assert.Equal(Sha(V1Bytes), marker.BaseChecksum);
        Assert.Equal(V1Bytes.Length, marker.BaseFileSize);
        Assert.Equal(new DateTimeOffset(2026, 9, 5, 12, 0, 0, TimeSpan.Zero), marker.CheckedOutAtUtc);
        Assert.Equal(edited, File.ReadAllBytes(PartPath));
        Assert.Single(Posts(handler, "/checkout"));
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task The_same_instant_in_another_form_is_the_same_timestamp()
    {
        SeedControlled();
        var handler = Server(heldWithoutMarker: true, checkoutStatus: HttpStatusCode.OK,
            checkoutBody: PostBody("already-mine", at: "2026-09-05T14:00:00+02:00"));

        var result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);

        Assert.False(result.ReconcileNeeded);
        Assert.Equal(new DateTimeOffset(2026, 9, 5, 12, 0, 0, TimeSpan.Zero), Entry().Checkout!.CheckedOutAtUtc);
    }

    public static TheoryData<string, HttpStatusCode> ChangedUnderneath => new()
    {
        { PostBody("already-mine", id: "co_OTHER"), HttpStatusCode.OK },
        { PostBody("already-mine", baseFv: "fv_2", baseVersion: 2), HttpStatusCode.OK },
        { PostBody("already-mine", at: "2026-09-05T12:00:01.000Z"), HttpStatusCode.OK },
        { PostBody("created"), HttpStatusCode.Created },
    };

    [Theory]
    [MemberData(nameof(ChangedUnderneath))]
    [Trait("PackageC", "Policy")]
    public async Task A_POST_that_disagrees_with_the_status_restores_nothing(string body, HttpStatusCode code)
    {
        SeedControlled();
        var handler = Server(heldWithoutMarker: true, checkoutStatus: code, checkoutBody: body);

        var result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);

        Assert.True(result.ReconcileNeeded);
        Assert.Null(Entry().Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_held_checkout_on_another_base_is_refused_before_the_POST()
    {
        SeedControlled();
        var handler = Server(heldWithoutMarker: true, statusBaseFv: "fv_2");

        var result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);

        Assert.True(result.ReconcileNeeded);
        Assert.Empty(Posts(handler, "/checkout"));
        Assert.Null(Entry().Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_Unverified_entry_cannot_regain_a_marker()
    {
        SeedControlled();
        WorkspaceManifest.LoadOrEmpty(_root).MarkUnverified(PartPath);
        var handler = Server(heldWithoutMarker: true);

        await Assert.ThrowsAsync<NotVerifiedException>(() => Orchestrator(handler).CheckoutAsync(_root, PartPath));

        Assert.Empty(handler.Requests);
        Assert.Null(Entry().Checkout);
    }

    [Theory]
    [InlineData("checksum", "not-a-sha")]
    [InlineData("fileSize", "0")]
    [InlineData("versionNumber", "0")]
    [InlineData("fileVersionId", " fv_1")]
    [Trait("PackageC", "Policy")]
    public async Task Base_metadata_that_is_missing_or_malformed_refuses_with_no_POST(string field, string value)
    {
        SeedControlled();
        EditManifest(m =>
        {
            var entry = m["entries"]![0]!.AsObject();
            entry[field] = field is "fileSize" or "versionNumber" ? int.Parse(value) : value;
        });
        var handler = Server(heldWithoutMarker: true);

        await Assert.ThrowsAnyAsync<Exception>(() => Orchestrator(handler).CheckoutAsync(_root, PartPath));

        Assert.Empty(Posts(handler, "/checkout"));
        Assert.Null(Entry().Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_user_who_lost_write_permission_regains_no_marker_and_no_write_access()
    {
        SeedControlled();
        var handler = Server(heldWithoutMarker: true, checkoutStatus: HttpStatusCode.Forbidden, checkoutBody: """{"error":"Your role does not permit checking out CAD documents"}""");

        await Assert.ThrowsAnyAsync<Exception>(() => Orchestrator(handler).CheckoutAsync(_root, PartPath));

        Assert.Null(Entry().Checkout);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_marker_that_cannot_be_saved_leaves_the_attribute_and_says_so_separately()
    {
        SeedControlled();
        using var holder = new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.Read);

        var result = await Orchestrator(Server(heldWithoutMarker: true)).CheckoutAsync(_root, PartPath);

        Assert.False(result.ManifestUpdated);
        Assert.False(result.MadeWritable);
        Assert.True(result.ReconcileNeeded);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Checkout_again_with_a_marker_stays_an_ordinary_repeat()
    {
        SeedControlled();
        await CheckoutFirst();
        var handler = Server(checkoutStatus: HttpStatusCode.OK, checkoutBody: PostBody("already-mine"));

        var result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);

        Assert.False(result.ReconcileNeeded);
        Assert.True(result.ManifestUpdated);
        Assert.Equal("co_1", Entry().Checkout!.CheckoutId);
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_failed_marker_save_then_every_command_stays_safe_until_Checkout_runs_again()
    {
        SeedControlled();
        var edited = "unsaved work"u8.ToArray();
        ManagedFileGuard.SetWritable(PartPath);
        File.WriteAllBytes(PartPath, edited);

        await Assert.ThrowsAsync<NotCheckedOutLocallyException>(() => Orchestrator(Server(heldWithoutMarker: true)).CheckInAsync(_root, PartPath));
        await Assert.ThrowsAsync<NotCheckedOutLocallyException>(() => Orchestrator(Server(heldWithoutMarker: true)).UndoAsync(_root, PartPath, reason: null));
        await Orchestrator(Server(heldWithoutMarker: true)).CheckoutAsync(_root, PartPath);

        Assert.NotNull(Entry().Checkout);
        Assert.Equal(edited, File.ReadAllBytes(PartPath));
    }

    // ---- the add-in's path, and a lock someone else holds ---------------------------

    private static WorkspaceLockAcquirer Locks() => new(WindowsLockPathSystem.Instance, WindowsLockHandleFactory.Instance);

    [Theory]
    [MemberData(nameof(Commands))]
    [Trait("PackageC", "Policy")]
    public async Task A_command_holding_the_lock_runs_its_operation_without_refusing_itself(string command)
    {
        SeedControlled();
        if (command != "Checkout")
        {
            await CheckoutFirst();
        }
        var held = new CommandLockGate(Locks(), null).Admit(WorkspaceLockRequest.ForDocument(command, PartPath), () => true).Lock!;

        await held.RunAsync(_ => Invoke(Orchestrator(Server()), command), CancellationToken.None);

        Assert.True(held.IsReleased);
    }

    [Theory]
    [MemberData(nameof(Commands))]
    [Trait("PackageC", "Policy")]
    public async Task A_lock_someone_else_holds_refuses_a_direct_caller_with_nothing_sent(string command)
    {
        SeedControlled();
        await CheckoutFirst();
        var before = AllFiles();
        var holder = Locks().TryAcquire(WorkspaceLockRequest.ForDocument("Another Inventor", PartPath)).Lease!;
        var handler = Server();

        try
        {
            var ex = await Assert.ThrowsAsync<ArchApiException>(() => Invoke(Orchestrator(handler), command));
            Assert.Contains("using this workspace", ex.Message);
        }
        finally
        {
            holder.Dispose();
        }

        Assert.Empty(handler.Requests);
        Assert.Equal(before, AllFiles());
    }

    [Theory]
    [MemberData(nameof(Commands))]
    [Trait("PackageC", "Policy")]
    public async Task A_direct_command_holds_the_lock_while_it_talks_to_the_server_and_lets_it_go(string command)
    {
        SeedControlled();
        await CheckoutFirst();
        var heldDuring = false;
        var server = Server();
        var handler = new FakeHttpHandler(req =>
        {
            var probe = Locks().TryAcquire(WorkspaceLockRequest.ForDocument("Another Inventor", PartPath));
            probe.Lease?.Dispose();
            heldDuring |= !probe.Acquired;
            return server.Respond(req);
        });

        await Record.ExceptionAsync(() => Invoke(Orchestrator(handler), command));

        Assert.True(heldDuring);
        var after = Locks().TryAcquire(WorkspaceLockRequest.ForDocument("Another Inventor", PartPath));
        Assert.True(after.Acquired, after.Refusal?.ErrorCode);
        after.Lease!.Dispose();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_workspace_root_that_does_not_contain_the_file_is_not_managed()
    {
        SeedControlled();
        var otherRoot = _root + "-other";
        Directory.CreateDirectory(Path.Combine(otherRoot, ".arch"));
        File.Copy(ManifestPath, Path.Combine(otherRoot, WorkspaceManifest.RelativeManifestPath));
        var handler = Server();
        try
        {
            await Assert.ThrowsAsync<NotManagedException>(() => Orchestrator(handler).CheckoutAsync(otherRoot, PartPath));
        }
        finally
        {
            Directory.Delete(otherRoot, recursive: true);
        }

        Assert.Empty(handler.Requests);
    }
}