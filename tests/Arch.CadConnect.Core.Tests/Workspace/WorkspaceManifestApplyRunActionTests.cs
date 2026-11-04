using System.Text.Json;

using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Core.Tests.Workspace;

/// <summary>P6 M4.4 Package C: <see cref="WorkspaceManifest.ApplyRun"/> and
///  <see cref="MaterializationEntryResult.ManifestAction"/>, without a
///  materializer.</summary>
public class WorkspaceManifestApplyRunActionTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "arch-cc-mfa-" + Guid.NewGuid().ToString("N"));

    public WorkspaceManifestApplyRunActionTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch { /* best effort */ }
    }

    private static readonly DateTimeOffset Then = new(2026, 10, 30, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset Now = Then.AddHours(1);

    private static readonly WorkspaceCheckoutBinding Marker = new()
    {
        CheckoutId = "co_1",
        BaseFileVersionId = "fv_1",
        BaseVersionNumber = 1,
        BaseChecksum = "aaa",
        BaseFileSize = 10,
        CheckedOutAtUtc = Then,
    };

    private static WorkspaceManifestRunContext Context(string root) => new("https://plm.example.com", "org1", "ACME", root, root.ToUpperInvariant());

    private static WorkspacePlan Plan(string cad = "cad_a", string fv = "fv_1") => new()
    {
        Contract = new WorkspacePlanContractRef { Id = WorkspacePlanContract.Id, Version = WorkspacePlanContract.Version },
        Root = new WorkspacePlanRoot { CadDocumentId = cad },
        Safe = true,
        Entries =
        [
            new WorkspacePlanEntry
            {
                CadDocumentId = cad,
                DocumentNumber = cad.ToUpperInvariant(),
                FileName = "a.ipt",
                CadType = "IPT",
                IsRoot = true,
                Placement = new WorkspacePlanPlacement { GeneratedRelativePath = "a.ipt" },
                CanMaterialize = true,
                Version = new WorkspacePlanVersion
                {
                    FileVersionId = fv,
                    VersionNumber = 1,
                    Checksum = "aaa",
                    FileSize = 10,
                    OriginalFileName = "a.ipt",
                    ContentPath = $"/api/file-versions/{fv}/content",
                },
            },
        ],
    };

    private static MaterializationReport Report(MaterializationStatus status, MaterializationManifestAction action, string cad = "cad_a", string fv = "fv_1") => new()
    {
        WorkspaceRoot = "x",
        RootCadDocumentId = cad,
        StartedAtUtc = Now,
        FinishedAtUtc = Now,
        RequestedEntries = 1,
        Results =
        [
            new MaterializationEntryResult
            {
                CadDocumentId = cad,
                FileVersionId = fv,
                RelativePath = "a.ipt",
                Status = status,
                Checksum = "aaa",
                ManifestAction = action,
            },
        ],
    };

    private WorkspaceManifest CheckedOutManifest()
    {
        var manifest = WorkspaceManifest.LoadOrEmpty(_root);
        manifest.ApplyRun(Report(MaterializationStatus.Downloaded, MaterializationManifestAction.Default), Plan(), Context("cad_a"), Then);
        manifest.SaveAtomic();
        Assert.True(manifest.MarkCheckedOut(Path.Combine(_root, "a.ipt"), Marker));
        return WorkspaceManifest.LoadOrEmpty(_root);
    }

    private string SavedRoot()
    {
        using var json = JsonDocument.Parse(File.ReadAllText(Path.Combine(_root, WorkspaceManifest.RelativeManifestPath)));
        return json.RootElement.GetProperty("rootCadDocumentId").GetString()!;
    }

    [Theory]
    [InlineData(MaterializationStatus.Downloaded)]
    [InlineData(MaterializationStatus.AlreadyCurrent)]
    [InlineData(MaterializationStatus.Blocked)]
    [InlineData(MaterializationStatus.Failed)]
    public void PreserveEntry_leaves_the_entry_exactly_as_it_was(MaterializationStatus status)
    {
        var manifest = CheckedOutManifest();
        var before = JsonSerializer.Serialize(manifest.Entries.Single());

        manifest.ApplyRun(Report(status, MaterializationManifestAction.PreserveEntry, fv: "fv_2"), Plan(fv: "fv_2"), Context("cad_a"), Now);

        Assert.Equal(before, JsonSerializer.Serialize(manifest.Entries.Single()));
    }

    [Theory]
    [InlineData(MaterializationStatus.Downloaded)]
    [InlineData(MaterializationStatus.AlreadyCurrent)]
    public void KeepCheckout_carries_the_marker_onto_the_verified_entry(MaterializationStatus status)
    {
        var manifest = CheckedOutManifest();

        manifest.ApplyRun(Report(status, MaterializationManifestAction.KeepCheckout), Plan(), Context("cad_a"), Now);

        var entry = manifest.Entries.Single();
        Assert.Equal(Marker, entry.Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Verified, entry.State);
        Assert.Equal(Now, entry.RetrievedAtUtc);
    }

    [Theory]
    [InlineData(MaterializationManifestAction.ClearCheckout)]
    [InlineData(MaterializationManifestAction.Default)]
    public void Without_KeepCheckout_a_verified_entry_has_no_marker(MaterializationManifestAction action)
    {
        var manifest = CheckedOutManifest();

        manifest.ApplyRun(Report(MaterializationStatus.AlreadyCurrent, action), Plan(), Context("cad_a"), Now);

        Assert.Null(manifest.Entries.Single().Checkout);
    }

    [Fact]
    public void A_blocked_local_conflict_keeps_the_marker_and_downgrades_the_entry()
    {
        var manifest = CheckedOutManifest();

        manifest.ApplyRun(Report(MaterializationStatus.Blocked, MaterializationManifestAction.KeepCheckout), Plan(), Context("cad_a"), Now);

        var entry = manifest.Entries.Single();
        Assert.Equal(Marker, entry.Checkout);
        Assert.Equal(WorkspaceManifestEntryState.Unverified, entry.State);
    }

    [Theory]
    [InlineData(MaterializationStatus.Blocked)]
    [InlineData(MaterializationStatus.Failed)]
    public void A_root_this_run_could_not_make_current_does_not_replace_the_manifest_root(MaterializationStatus status)
    {
        var manifest = CheckedOutManifest();

        manifest.ApplyRun(Report(status, MaterializationManifestAction.Default, cad: "cad_b"), Plan("cad_b"), Context("cad_b"), Now);
        manifest.SaveAtomic();

        Assert.Equal("cad_a", SavedRoot());
    }

    [Theory]
    [InlineData(MaterializationStatus.Downloaded)]
    [InlineData(MaterializationStatus.AlreadyCurrent)]
    public void A_current_root_replaces_the_manifest_root(MaterializationStatus status)
    {
        var manifest = CheckedOutManifest();

        manifest.ApplyRun(Report(status, MaterializationManifestAction.Default, cad: "cad_b"), Plan("cad_b"), Context("cad_b"), Now);
        manifest.SaveAtomic();

        Assert.Equal("cad_b", SavedRoot());
    }

    [Fact]
    public void A_first_run_that_could_not_make_its_root_current_leaves_the_root_empty()
    {
        var manifest = WorkspaceManifest.LoadOrEmpty(_root);

        manifest.ApplyRun(Report(MaterializationStatus.Blocked, MaterializationManifestAction.Default), Plan(), Context("cad_a"), Now);
        manifest.SaveAtomic();

        Assert.Equal("", SavedRoot());
    }
}
