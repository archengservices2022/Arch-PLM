using System.Net;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json.Nodes;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R10 NO-GO corrections (MAJOR 3, MINOR 1-3): a status
///  that would clear a marker must be complete, Check In and Undo act only on a
///  complete marker, the marker's time is the server's, and a file gains write
///  access only once its record is saved. Every refusal is checked against the
///  full manifest bytes, the CAD bytes, the file's attributes and the requests
///  made. Test IDs follow the approved correction plan.</summary>
public partial class CheckoutOrchestratorTests
{
    private sealed record LocalState(byte[] Manifest, byte[] Cad, FileAttributes Attributes);

    private LocalState State() => new(File.ReadAllBytes(ManifestPath), File.ReadAllBytes(PartPath), File.GetAttributes(PartPath));

    private void AssertUnchanged(LocalState before)
    {
        var now = State();
        Assert.Equal(before.Manifest, now.Manifest);
        Assert.Equal(before.Cad, now.Cad);
        Assert.Equal(before.Attributes, now.Attributes);
    }

    /// <summary>Only status reads: nothing uploaded, released or downloaded.</summary>
    private static void AssertOnlyStatusReads(FakeHttpHandler handler)
    {
        Assert.NotEmpty(handler.Requests);
        Assert.All(handler.Requests, r =>
        {
            Assert.Equal(HttpMethod.Get, r.Method);
            Assert.Equal("/api/cad-documents/cad_part/checkout", r.RequestUri!.AbsolutePath);
        });
    }

    private static readonly string CompleteLocked = """
        {"state":"locked","checkout":{"id":"co_9","cadDocumentId":"cad_part","baseFileVersionId":"fv_1","baseVersionNumber":1,
         "checkedOutById":"u2","checkedOutAt":"2026-09-05T12:00:00.000Z","checkedOutBy":{"name":"Sam","email":"sam@orga.com"}}}
        """;

    private static string LockedWith(Action<JsonObject> change)
    {
        var body = JsonNode.Parse(CompleteLocked)!.AsObject();
        change(body["checkout"]!.AsObject());
        return body.ToJsonString();
    }

    public static TheoryData<string, string> MalformedLockedStatuses
    {
        get
        {
            var bodies = new[]
            {
                """{"state":"locked"}""",
                """{"state":"locked","checkout":null}""",
                LockedWith(c => c.Remove("id")),
                LockedWith(c => c["id"] = " co_9"),
                LockedWith(c => c.Remove("baseFileVersionId")),
                LockedWith(c => c["baseFileVersionId"] = "fv_1 "),
                LockedWith(c => c["baseVersionNumber"] = 0),
                LockedWith(c => c["baseVersionNumber"] = -1),
                LockedWith(c => c.Remove("baseVersionNumber")),
                LockedWith(c => c.Remove("checkedOutAt")),
                LockedWith(c => c["checkedOutAt"] = "2026-09-05T12:00:00"),
                LockedWith(c => c["checkedOutAt"] = "yesterday"),
                LockedWith(c => c.Remove("checkedOutById")),
                LockedWith(c => c["checkedOutById"] = "u1"),
                LockedWith(c => c["cadDocumentId"] = "cad_other"),
            };
            var data = new TheoryData<string, string>();
            foreach (var command in new[] { "CheckIn", "Undo" })
            {
                foreach (var body in bodies)
                {
                    data.Add(command, body);
                }
            }
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(MalformedLockedStatuses))]
    [Trait("PackageC", "R10Fix")]
    public async Task S1_an_incomplete_or_malformed_locked_answer_clears_nothing(string command, string body)
    {
        SeedControlled();
        await CheckoutFirst();
        var before = State();
        var handler = new FakeHttpHandler(_ => Json(HttpStatusCode.OK, body));

        var ex = await Assert.ThrowsAsync<ArchApiException>(() => Invoke(Orchestrator(handler), command));

        Assert.Equal(ArchApiFailureKind.Server, ex.Kind);
        AssertUnchanged(before);
        AssertOnlyStatusReads(handler);
    }

    public static TheoryData<string, string> ContradictoryStatuses
    {
        get
        {
            var mine = """{"state":"mine","checkout":{"id":"co_1","cadDocumentId":"cad_part","baseFileVersionId":"fv_1","baseVersionNumber":1,"checkedOutById":"u1","checkedOutAt":"2026-09-05T12:00:00.000Z"}}""";
            var bodies = new[]
            {
                """{"state":"available","checkout":{"id":"co_1","cadDocumentId":"cad_part"}}""",
                mine.Replace("\"u1\"", "\"u2\""),
                """{"state":"something-new"}""",
                mine.Replace("\"baseFileVersionId\":\"fv_1\",", ""),
            };
            var data = new TheoryData<string, string>();
            foreach (var command in new[] { "CheckIn", "Undo" })
            {
                foreach (var body in bodies)
                {
                    data.Add(command, body);
                }
            }
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(ContradictoryStatuses))]
    [Trait("PackageC", "R10Fix")]
    public async Task S2_a_contradictory_available_mine_or_unknown_answer_clears_nothing(string command, string body)
    {
        SeedControlled();
        await CheckoutFirst();
        var before = State();
        var handler = new FakeHttpHandler(_ => Json(HttpStatusCode.OK, body));

        await Assert.ThrowsAsync<ArchApiException>(() => Invoke(Orchestrator(handler), command));

        AssertUnchanged(before);
        AssertOnlyStatusReads(handler);
    }

    [Theory]
    [InlineData("CheckIn")]
    [InlineData("Undo")]
    [Trait("PackageC", "R10Fix")]
    public async Task S3_a_complete_locked_answer_still_reconciles_the_marker(string command)
    {
        SeedControlled();
        await CheckoutFirst();
        var cad = File.ReadAllBytes(PartPath);
        var handler = new FakeHttpHandler(_ => Json(HttpStatusCode.OK, CompleteLocked));

        await Assert.ThrowsAsync<CheckoutConflictException>(() => Invoke(Orchestrator(handler), command));

        Assert.Null(Entry().Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Unverified, Entry().State);
        Assert.Equal(cad, File.ReadAllBytes(PartPath));
        AssertOnlyStatusReads(handler);
    }

    [Theory]
    [InlineData("CheckIn", "available")]
    [InlineData("Undo", "available")]
    [InlineData("CheckIn", "other-checkout")]
    [InlineData("Undo", "other-checkout")]
    [Trait("PackageC", "R10Fix")]
    public async Task S4_S5_a_valid_available_or_another_checkout_of_mine_still_reconciles_the_marker(string command, string answer)
    {
        SeedControlled();
        await CheckoutFirst();
        var cad = File.ReadAllBytes(PartPath);
        var handler = answer == "available"
            ? Server(statusState: "available")
            : Server(statusState: "mine", statusCheckoutId: "co_OTHER");

        await Assert.ThrowsAsync<StaleCheckoutException>(() => Invoke(Orchestrator(handler), command));

        Assert.Null(Entry().Checkout);
        Assert.Equal(cad, File.ReadAllBytes(PartPath));
        AssertOnlyStatusReads(handler);
    }

    public static TheoryData<string, string, string?> IncompleteMarkers
    {
        get
        {
            var fields = new (string Field, string? Value)[]
            {
                ("checkoutId", "\"\""),
                ("checkoutId", "\" co_1\""),
                ("baseFileVersionId", "\"fv_1 \""),
                ("baseFileVersionId", "\"\""),
                ("baseVersionNumber", "0"),
                ("baseChecksum", "\"not-a-sha\""),
                ("baseChecksum", "\"\""),
                ("baseFileSize", "0"),
                ("checkedOutAtUtc", null),
            };
            var data = new TheoryData<string, string, string?>();
            foreach (var command in new[] { "CheckIn", "Undo" })
            {
                foreach (var (field, value) in fields)
                {
                    data.Add(command, field, value);
                }
            }
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(IncompleteMarkers))]
    [Trait("PackageC", "R10Fix")]
    public async Task M1_an_incomplete_marker_refuses_before_any_request(string command, string field, string? value)
    {
        SeedControlled();
        await CheckoutFirst();
        EditManifest(m =>
        {
            var marker = m["entries"]![0]!["checkout"]!.AsObject();
            if (value is null) marker.Remove(field); else marker[field] = JsonNode.Parse(value);
        });
        var before = State();
        var handler = Server();

        await Assert.ThrowsAsync<NotCheckedOutLocallyException>(() => Invoke(Orchestrator(handler), command));

        AssertUnchanged(before);
        Assert.Empty(handler.Requests);
    }

    // ---- MINOR 2: the server's time ------------------------------------------------

    [Fact]
    [Trait("PackageC", "R10Fix")]
    public async Task W3_a_new_checkout_records_the_servers_instant_not_this_machines_clock()
    {
        SeedControlled();

        // The orchestrator's clock reads 2026-09-06; the server says 2026-09-05 12:00Z.
        var result = await Orchestrator(Server(statusState: "available")).CheckoutAsync(_root, PartPath);

        Assert.True(result.ManifestUpdated);
        Assert.Equal(new DateTimeOffset(2026, 9, 5, 12, 0, 0, TimeSpan.Zero), Entry().Checkout!.CheckedOutAtUtc);
    }

    [Fact]
    [Trait("PackageC", "R10Fix")]
    public async Task W4_an_existing_checkout_records_the_servers_instant()
    {
        SeedControlled();

        await Orchestrator(Server(heldWithoutMarker: true)).CheckoutAsync(_root, PartPath);

        Assert.Equal(new DateTimeOffset(2026, 9, 5, 12, 0, 0, TimeSpan.Zero), Entry().Checkout!.CheckedOutAtUtc);
    }

    // ---- MINOR 3: no record, no write access --------------------------------------

    public static TheoryData<string, bool> SaveFailures => new()
    {
        { "available-then-already-mine", true },
        { "available-then-already-mine", false },
        { "created", true },
        { "created", false },
    };

    [Theory]
    [MemberData(nameof(SaveFailures))]
    [Trait("PackageC", "R10Fix")]
    public async Task W1_W5_W6_W8_a_marker_that_cannot_be_saved_leaves_the_files_attributes_exactly_as_they_were(string flow, bool startsReadOnly)
    {
        SeedControlled();
        if (!startsReadOnly)
        {
            ManagedFileGuard.SetWritable(PartPath);
        }
        var before = State();
        var handler = flow == "created"
            ? Server(statusState: "available")
            : Server(statusState: "available", checkoutStatus: HttpStatusCode.OK, checkoutBody: PostBody("already-mine"));

        CheckoutOperationResult result;
        using (new FileStream(ManifestPath, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);
        }

        Assert.False(result.ManifestUpdated);
        Assert.False(result.MadeWritable);
        Assert.True(result.ReconcileNeeded);
        AssertUnchanged(before);
        Assert.Equal(startsReadOnly, ManagedFileGuard.IsControlled(PartPath));
        Assert.Single(Posts(handler, "/checkout"));
        Assert.Empty(Posts(handler, "/undo"));
    }

    [Fact]
    [Trait("PackageC", "R10Fix")]
    [SupportedOSPlatform("windows")] // denies an ACL right to make the attribute change fail
    public async Task W7_a_saved_marker_whose_attribute_change_fails_is_reported_as_partly_done()
    {
        SeedControlled();
        var info = new FileInfo(PartPath);
        var denial = new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.WriteAttributes, AccessControlType.Deny);
        var acl = info.GetAccessControl();
        acl.AddAccessRule(denial);
        info.SetAccessControl(acl);
        var handler = Server(statusState: "available");
        CheckoutOperationResult result;
        try
        {
            result = await Orchestrator(handler).CheckoutAsync(_root, PartPath);
        }
        finally
        {
            acl.RemoveAccessRule(denial);
            info.SetAccessControl(acl);
        }

        Assert.True(result.ManifestUpdated);
        Assert.False(result.MadeWritable);
        Assert.True(result.ReconcileNeeded);
        Assert.Contains("could not clear read-only", result.Message);
        Assert.Equal("co_1", Entry().Checkout!.CheckoutId);
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
        Assert.Empty(Posts(handler, "/undo"));
    }
}
