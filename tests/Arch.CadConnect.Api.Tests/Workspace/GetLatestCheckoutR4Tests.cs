using System.Diagnostics;
using System.Net;
using System.Text.Json.Nodes;

using Arch.CadConnect.Api.Workspace;
using Arch.CadConnect.Core.Documents;
using Arch.CadConnect.Core.Files;
using Arch.CadConnect.Core.Workspace;

namespace Arch.CadConnect.Api.Tests.Workspace;

/// <summary>P6 M4.4 Package C R4: replacements interrupted before they finished,
///  a recovery folder that is not what it seems, and malformed document ids.</summary>
public partial class GetLatestCheckoutConsistencyTests
{
    private static HttpResponseMessage StatusFails(string _) => FakeHttpHandler.Json(HttpStatusCode.InternalServerError, "{}");

    // ---- restart after an interrupted replacement ---------------------------

    /// <summary>Leaves the workspace as a process killed during promotion leaves
    ///  it: the original gone from its path, its copy and record in .recovery.
    ///  The recovery folder is captured at the moment of promotion, while the
    ///  run is under way, then put back once that run has unwound.</summary>
    private async Task<Dictionary<string, byte[]>> InterruptedReplacement()
    {
        await CheckedOutPart();
        var captured = new Dictionary<string, byte[]>();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (_, _) =>
        {
            foreach (var file in Directory.GetFiles(RecoveryPath))
            {
                // The copy itself is pinned by then; only its path is needed.
                captured[file] = file.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase) ? File.ReadAllBytes(file) : [];
            }
            throw new IOException("power cut");
        });

        await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        Assert.NotEmpty(captured);
        File.Move(PartPath, captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase)));
        foreach (var (file, bytes) in captured.Where(c => c.Key.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase)))
        {
            File.WriteAllBytes(file, bytes);
        }
        return captured;
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_restart_puts_an_interrupted_original_back_before_anything_else()
    {
        await InterruptedReplacement();
        var marker = Entry(PartPath).Checkout;

        var report = await Run(Server([RootPartNewVersion], StatusFails), "PRT-1");

        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
        Assert.Equal(marker, Entry(PartPath).Checkout);
        Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_restart_restores_edited_bytes_exactly()
    {
        var captured = await InterruptedReplacement();
        var aside = captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));
        await File.WriteAllBytesAsync(aside, EditedBytes);

        await Run(Server([RootPartNewVersion], StatusFails), "PRT-1");

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Empty(RecoveryFiles());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_restart_that_finds_another_file_at_the_path_refuses_and_names_the_copy()
    {
        var captured = await InterruptedReplacement();
        var aside = captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        var handler = Server(RootPartNewVersion);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Contains(Path.GetFileName(aside), ex.Message);
        Assert.Empty(handler.Requests);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(aside));
        Assert.NotNull(Entry(PartPath).Checkout);
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Moving_the_copy_out_of_recovery_clears_the_refusal()
    {
        var captured = await InterruptedReplacement();
        var aside = captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));
        await File.WriteAllBytesAsync(PartPath, EditedBytes);
        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(Server(RootPartNewVersion), "PRT-1"));

        File.Move(aside, Path.Combine(_root, "kept-elsewhere.ipt"));
        await Run(Server([RootPart], StatusFails), "PRT-1");

        Assert.Empty(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_replacement_interrupted_after_promotion_keeps_its_copy_on_restart_and_names_it()
    {
        var captured = await InterruptedReplacement();
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        var copy = Assert.Single(RecoveryFiles());
        Assert.Contains(Path.GetFileName(copy), ex.Message);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(copy));
        Assert.Equal(NewPartBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.True(File.Exists(JournalOf(captured)));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_copy_changed_while_interrupted_after_promotion_is_not_thrown_away()
    {
        var captured = await InterruptedReplacement();
        var aside = captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));
        await File.WriteAllBytesAsync(PartPath, NewPartBytes);
        await File.WriteAllBytesAsync(aside, EditedBytes);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(aside));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_restart_with_the_document_open_refuses_and_keeps_the_copy()
    {
        var captured = await InterruptedReplacement();
        var aside = captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase));

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(new ScriptedProbe(_ => true))));

        Assert.True(File.Exists(aside));
        Assert.False(File.Exists(PartPath));
    }

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData("{ this is not json")]
    [InlineData("""{"schema":"something-else"}""")]
    [InlineData("""{"schema":"arch-plm.pending-replacement.v1","relativePath":"part.ipt","asideFileName":"..\\..\\outside.ipt","baseChecksum":"x","baseFileSize":1,"planChecksum":"y","planFileSize":1}""")]
    [InlineData("""{"schema":"arch-plm.pending-replacement.v1","relativePath":"..\\outside.ipt","asideFileName":"x.ipt","baseChecksum":"x","baseFileSize":1,"planChecksum":"y","planFileSize":1}""")]
    public async Task A_recovery_record_that_cannot_be_trusted_refuses_and_changes_nothing(string record)
    {
        var captured = await InterruptedReplacement();
        await File.WriteAllTextAsync(captured.Keys.Single(f => f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase)), record);
        var handler = Server(RootPart);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Contains(".recovery", ex.Message);
        Assert.Empty(handler.Requests);
        Assert.False(File.Exists(PartPath), "nothing is restored on an untrusted record");
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(captured.Keys.Single(f => !f.EndsWith(".pending.json", StringComparison.OrdinalIgnoreCase))));
    }

    // ---- cancellation or failure with a failed restoration -------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_with_a_failed_restoration_reports_the_copy_and_keeps_both_files()
    {
        await CheckedOutPart();
        using var cancel = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (_, target) =>
        {
            File.WriteAllBytes(target, EditedBytes);
            cancel.Cancel();
            cancel.Token.ThrowIfCancellationRequested();
        });

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", ct: cancel.Token, materializer: materializer);

        Assert.Contains(".recovery", report.Results.Single().Reason);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(PartPath));
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(Assert.Single(RecoveryFiles())));
        Assert.Single(RecoveryJournals());
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_with_a_failed_restoration_before_more_entries_names_the_copy()
    {
        var asmPath = await TwoStaleCheckouts();
        using var cancel = new CancellationTokenSource();
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (_, target) =>
        {
            File.WriteAllBytes(target, EditedBytes);
            cancel.Cancel();
            cancel.Token.ThrowIfCancellationRequested();
        });

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() =>
            Run(Server([AsmNewVersion, DependencyPart], _ => Available), "ASM-1", ct: cancel.Token, materializer: materializer));

        Assert.Contains(".recovery", ex.Message);
        Assert.Equal(EditedBytes, await File.ReadAllBytesAsync(asmPath));
        Assert.Equal(AsmBytes, await File.ReadAllBytesAsync(Assert.Single(RecoveryFiles())));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_unexpected_exception_during_promotion_puts_the_original_back()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, promoteFile: (_, _) => throw new InvalidOperationException("unexpected"));

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        Assert.Equal(MaterializationStatus.Failed, report.Results.Single().Status);
        await unchanged();
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    // ---- the final cancellation boundary -------------------------------------

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task Cancellation_at_the_final_probe_never_reaches_promotion()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        using var cancel = new CancellationTokenSource();
        var promoted = false;
        var calls = 0;
        var probe = new ScriptedProbe(call =>
        {
            calls = call;
            if (call == 3)
            {
                cancel.Cancel();
            }
            return false;
        });
        var materializer = new WorkspaceMaterializer(probe, promoteFile: (source, target) =>
        {
            promoted = true;
            File.Move(source, target);
        });

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", ct: cancel.Token, materializer: materializer));

        Assert.Equal(3, calls);
        Assert.False(promoted);
        await unchanged();
        Assert.Empty(RecoveryFiles());
        Assert.Empty(RecoveryJournals());
    }

    // ---- the recovery folder is not what it seems ------------------------------

    private static void Junction(string link, string target)
    {
        using var process = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        })!;
        process.WaitForExit();
        Assert.Equal(0, process.ExitCode);
    }

    private string Outside()
    {
        var outside = _root + "-outside";
        Directory.CreateDirectory(outside);
        _outsideFolders.Add(outside);
        return outside;
    }

    private readonly List<string> _outsideFolders = [];

    private void RemoveJunctionAndOutside()
    {
        foreach (var outside in _outsideFolders)
        {
            try { Directory.Delete(outside, recursive: true); } catch { /* best effort */ }
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_junction_at_the_recovery_folder_refuses_and_nothing_leaves_the_workspace()
    {
        await CheckedOutPart();
        var outside = Outside();
        try
        {
            Junction(RecoveryPath, outside);
            var unchanged = await ExpectUnchanged(PartPath);
            var handler = ServerAnswering(RootPartNewVersion, AvailableJson);

            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

            await unchanged();
            Assert.Empty(Directory.GetFiles(outside));
            Assert.Empty(handler.Requests);
        }
        finally
        {
            Directory.Delete(RecoveryPath);
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_junction_that_appears_after_the_first_checks_blocks_the_replacement()
    {
        await CheckedOutPart();
        var outside = Outside();
        var unchanged = await ExpectUnchanged(PartPath);
        var probe = new ScriptedProbe(call =>
        {
            if (call == 2)
            {
                Junction(RecoveryPath, outside);
            }
            return false;
        });

        try
        {
            var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: With(probe));

            Assert.Equal(MaterializationStatus.Blocked, report.Results.Single().Status);
            Assert.Contains("recovery", report.Results.Single().Reason);
            await unchanged();
            Assert.Empty(Directory.GetFiles(outside));
        }
        finally
        {
            if (Directory.Exists(RecoveryPath))
            {
                Directory.Delete(RecoveryPath);
            }
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_file_at_the_recovery_folder_path_refuses_and_changes_nothing()
    {
        await CheckedOutPart();
        await File.WriteAllTextAsync(RecoveryPath, "not a folder");
        var unchanged = await ExpectUnchanged(PartPath);
        var handler = ServerAnswering(RootPartNewVersion, AvailableJson);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        await unchanged();
        Assert.Empty(handler.Requests);
        Assert.Equal("not a folder", await File.ReadAllTextAsync(RecoveryPath));
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task A_junction_pointing_back_inside_the_workspace_is_refused_too()
    {
        await CheckedOutPart();
        var inside = Path.Combine(_root, ".arch", "elsewhere");
        Directory.CreateDirectory(inside);
        try
        {
            Junction(RecoveryPath, inside);
            var unchanged = await ExpectUnchanged(PartPath);

            await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1"));

            await unchanged();
            Assert.Empty(Directory.GetFiles(inside));
        }
        finally
        {
            Directory.Delete(RecoveryPath);
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public void A_junction_at_the_arch_folder_is_refused_even_with_a_real_recovery_folder_behind_it()
    {
        var workspace = Path.Combine(_root, "ws");
        Directory.CreateDirectory(workspace);
        var outside = Outside();
        Directory.CreateDirectory(Path.Combine(outside, ".recovery"));
        try
        {
            Junction(Path.Combine(workspace, ".arch"), outside);

            Assert.Null(WorkspaceRecoveryFolder.TryOpen(workspace, create: false));
            Assert.Null(WorkspaceRecoveryFolder.TryOpen(workspace, create: true));
        }
        finally
        {
            Directory.Delete(Path.Combine(workspace, ".arch"));
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public void A_sibling_sharing_the_workspace_name_as_a_prefix_is_outside_it()
    {
        var outside = Outside();
        Directory.CreateDirectory(Path.Combine(_root, ".arch"));
        try
        {
            Junction(RecoveryPath, outside);

            Assert.StartsWith(_root, outside, StringComparison.OrdinalIgnoreCase);
            Assert.Null(WorkspaceRecoveryFolder.TryOpen(_root, create: false));
        }
        finally
        {
            Directory.Delete(RecoveryPath);
            RemoveJunctionAndOutside();
        }
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public void The_real_folder_opens_and_cannot_be_renamed_away_while_held()
    {
        using (var folder = WorkspaceRecoveryFolder.TryOpen(_root, create: true))
        {
            Assert.NotNull(folder);
            Assert.True(Directory.Exists(folder!.Path));

            Assert.ThrowsAny<IOException>(() => Directory.Move(RecoveryPath, RecoveryPath + "-moved"));
        }

        Directory.Move(RecoveryPath, RecoveryPath + "-moved");
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_unknown_folder_identity_blocks_the_replacement_before_the_original_moves()
    {
        await CheckedOutPart();
        var unchanged = await ExpectUnchanged(PartPath);
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, openRecovery: (_, _) => null);

        var report = await Run(ServerAnswering(RootPartNewVersion, AvailableJson), "PRT-1", materializer: materializer);

        Assert.Equal(GetLatestCheckoutPolicy.RecoveryFolderUnsafeReason, report.Results.Single().Reason);
        await unchanged();
    }

    [Fact]
    [Trait("PackageC", "Policy")]
    public async Task An_unknown_folder_identity_at_restart_refuses_before_any_request()
    {
        await InterruptedReplacement();
        var handler = Server(RootPart);
        var materializer = new WorkspaceMaterializer(NoEditorProbe.Instance, openRecovery: (_, _) => null);

        var ex = await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1", materializer: materializer));

        Assert.Equal(GetLatestCheckoutPolicy.RecoveryFolderUnsafeMessage, ex.Message);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    [Trait("PackageC", "Baseline")]
    public async Task A_recovery_folder_with_files_from_Undo_and_no_records_is_left_alone()
    {
        await CheckedOutPart();
        Directory.CreateDirectory(RecoveryPath);
        var undoFile = Path.Combine(RecoveryPath, "part.recovery-0123.ipt");
        await File.WriteAllBytesAsync(undoFile, PartBytes);

        var report = await Run(Server(RootPart), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
        Assert.Equal(PartBytes, await File.ReadAllBytesAsync(undoFile));
    }

    // ---- malformed document ids ------------------------------------------------

    [Theory]
    [Trait("PackageC", "Policy")]
    [InlineData(" cad_part")]
    [InlineData("cad_part ")]
    [InlineData("\tcad_part")]
    [InlineData("cad\tpart")]
    [InlineData("cad\npart")]
    [InlineData("cad\u0000part")]
    [InlineData("cad\u007Fpart")]
    [InlineData("cad_part ")]
    public async Task A_padded_or_control_character_document_id_is_refused_and_not_normalized(string id)
    {
        await CheckedOutPart();
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(ManifestPath))!;
        manifest["entries"]![0]!["cadDocumentId"] = id;
        await File.WriteAllTextAsync(ManifestPath, manifest.ToJsonString());
        var bytes = await File.ReadAllBytesAsync(ManifestPath);
        var handler = Server(RootPart);

        await Assert.ThrowsAsync<WorkspaceRootException>(() => Run(handler, "PRT-1"));

        Assert.Empty(handler.Requests);
        Assert.Equal(bytes, await File.ReadAllBytesAsync(ManifestPath));
        Assert.False(ManagedFileGuard.IsControlled(PartPath));
    }

    [Theory]
    [Trait("PackageC", "Baseline")]
    [InlineData("cmvqvh11g001dn45g940o86v0")]
    [InlineData("cad_part")]
    [InlineData("CAD-part.1")]
    public async Task A_valid_document_id_is_accepted(string id)
    {
        await Run(Server(RootPart with { Id = id }), "PRT-1");

        var report = await Run(Server(RootPart with { Id = id }), "PRT-1");

        Assert.Equal(MaterializationStatus.AlreadyCurrent, report.Results.Single().Status);
    }
}
