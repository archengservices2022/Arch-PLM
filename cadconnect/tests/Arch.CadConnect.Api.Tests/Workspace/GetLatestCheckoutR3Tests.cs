using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R3: concurrent saves around a stale-base
///  replacement, a document opened while a missing stale file downloads, and
///  manifests that parse but are not structurally sound.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private string RecoveryPath => Path.Combine(_root, ".arch", ".recovery");

    private string[] RecoveryFiles() => Directory.Exists(RecoveryPath)
        ? Directory.GetFiles(RecoveryPath).Where(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase)).ToArray()
        : [];

    private string[] RecoveryJournals() => Directory.Exists(RecoveryPath) ? Directory.GetFiles(RecoveryPath, "*.pending.json") : [];

    // ---- saves around the replacement ------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Bytes_saved_during_the_final_probe_are_kept()
    {
        await CheckedOutPart();
        var entry = JsonOf(Entry(PartPath));
        var probe = new ScriptedProbe(call =>
        {
            if (call == 2)
            {
                File.WriteAllBytes(PartPath, EditedBytes);
            }
            return false;
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.StaleConflictReason, report.Results.Single().Reason);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
        Assert.Empty(RecoveryFiles());
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_read_only_original_that_changed_is_put_back_read_only()
    {
        await CheckedOutPart();
        await File.WriteAllBytesAsync(PartPath, PartBytes);
        File.SetAttributes(PartPath, FileAttributes.ReadOnly);
        var probe = new ScriptedProbe(call =>
        {
            if (call == 2)
            {
                File.SetAttributes(PartPath, FileAttributes.Normal);
                File.WriteAllBytes(PartPath, EditedBytes);
                File.SetAttributes(PartPath, FileAttributes.ReadOnly);
            }
            return false;
        });

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(ManagedFileGuard.IsControlled(PartPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_saved_at_the_path_after_the_original_moved_aside_is_kept_and_so_is_the_original()
    {
        await CheckedOutPart();
        var entry = JsonOf(Entry(PartPath));
        var probe = new ScriptedProbe(call =>
        {
            if (call == 3)
            {
                File.WriteAllBytes(PartPath, EditedBytes);
            }
            return false;
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        var result = report.Results.Single();
        Assert.NotEqual(MaterializationStatus.Downloaded, result.Status);
        Assert.Contains(".recovery", result.Reason);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(Assert.Single(RecoveryFiles())));
        Assert.Equal(entry, JsonOf(Entry(PartPath)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_at_the_final_probe_puts_the_original_back()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        using var cancel = new CancellationTokenSource();
        var probe = new ScriptedProbe(call =>
        {
            if (call == 3)
            {
                cancel.Cancel();
            }
            return false;
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", ct: cancel.Token, materializer: With(probe)));

        await unchanged();
        Assert.Empty(RecoveryFiles());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_successful_replacement_leaves_no_copy_behind()
    {
        await CheckedOutPart();

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1");

        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Empty(RecoveryFiles());
        AssertNoStagedFiles();
    }

    // ---- a document opened while a missing stale file downloads ------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_document_opened_while_a_missing_stale_file_downloads_blocks_the_restore()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1", materializer: With(new ScriptedProbe(call => call > 1)));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
        AssertNoStagedFiles();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_probe_failure_while_a_missing_stale_file_downloads_blocks_the_restore()
    {
        await CheckedOutPart();
        File.Delete(PartPath);
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new ScriptedProbe(call => call > 1 ? throw new InvalidOperationException("Inventor is busy") : false);

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    // ---- the production scan behind Get Latest -------------------------------

    private sealed class FailingEditor(Exception failure) : IEditorDocumentStateProbe
    {
        public EditorDocumentState GetDocumentState(string absoluteFilePath) => EditorDocumentScan.Inspect<string>(
            absoluteFilePath,
            () => ["other.ipt"],
            _ => throw failure,
            _ => []);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_COM_failure_reading_an_open_document_blocks_stale_replacement()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new FailingEditor(new COMException("RPC_E_CALL_REJECTED", unchecked((int)0x80010001)));

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_COM_failure_reading_an_open_document_blocks_making_a_stale_file_read_only()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new FailingEditor(new InvalidComObjectException("the object was released"));

        var report = await Run(ServerAnswering(RootPart, AvailableJson), "PRT-1", materializer: With(probe));

        Assert.Equal(GetLatestCheckoutPolicy.DocumentOpenReason, report.Results.Single().Reason);
        await unchanged();
    }

    // ---- manifests that parse but are not sound ----------------------------

    public static TheoryData<string, Action<JsonArray>> UnsoundEntries => new()
    {
        { "same path twice", entries => entries.Add(entries[0]!.DeepClone()) },
        {
            "unmarked entry first, marked entry second",
            entries =>
            {
                var unmarked = entries[0]!.DeepClone();
                unmarked.AsObject().Remove("checkout");
                entries.Insert(0, unmarked);
            }
        },
        {
            "paths differing only in case",
            entries =>
            {
                var copy = entries[0]!.DeepClone();
                copy["relativePath"] = "PART.IPT";
                entries.Add(copy);
            }
        },
        {
            "paths differing only in surrounding space",
            entries =>
            {
                var copy = entries[0]!.DeepClone();
                copy["relativePath"] = " part.ipt ";
                entries.Add(copy);
            }
        },
        { "blank path", entries => entries[0]!["relativePath"] = "   " },
        { "no path", entries => entries[0]!.AsObject().Remove("relativePath") },
        { "null path", entries => entries[0]!["relativePath"] = null },
        { "null entry", entries => entries.Add((JsonNode?)null) },
        { "no document id", entries => entries[0]!.AsObject().Remove("cadDocumentId") },
        { "path outside the workspace", entries => entries[0]!["relativePath"] = @"..\outside.ipt" },
    };

    [Theory]
    [Trait("PackageC", "Policy")]
    [MemberData(nameof(UnsoundEntries))]
    public async Task An_unsound_manifest_is_refused_before_anything_changes(string name, Action<JsonArray> breakIt)
    {
        Assert.NotEmpty(name);
        await CheckedOutPart();
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(ManifestPath))!;
        breakIt(manifest["entries"]!.AsArray());
        await File.WriteAllTextAsync(ManifestPath, manifest.ToJsonString());
        var manifestBytes = await File.ReadAllBytesAsync(ManifestPath);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Empty(handler.Requests);
        Assert.Equal(manifestBytes, await File.ReadAllBytesAsync(ManifestPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath), "nothing may change the attribute of an existing file");
    }

    private static string JsonOf(WorkspaceManifestEntry entry) => System.Text.Json.JsonSerializer.Serialize(entry);
}
