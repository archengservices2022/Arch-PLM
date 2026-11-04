using System.Runtime.CompilerServices;

namespace Arch.CadConnect.Core.Tests.Wiring;

/// <summary>
/// R10 MA-7 - Undo Checkout target recovery wiring. The Inventor controller
/// cannot be compiled into a test project, so (like the other wiring tests)
/// this reads its source and proves: the ribbon and the Undo command use the
/// single-checkout fallback ONLY when nothing better is known; the fallback
/// reads the selected workspace and never writes; Undo still asks for
/// confirmation, takes its lock and runs the orchestrator; and the new
/// diagnostics carry only allowlisted ids, codes, counts and paths. The
/// fallback's decision itself is tested in UndoTargetMemoryTests.
/// </summary>
public class UndoTargetFallbackWiringSourceTests
{
    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", ".."));

    private static string Controller() =>
        File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "ArchAddInController.cs"));

    private static string Body(string source, string signatureFragment)
    {
        var start = source.IndexOf(signatureFragment, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Could not locate '{signatureFragment}'.");
        var open = source.IndexOf('{', start);
        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}' && --depth == 0) return source[open..(i + 1)];
        }
        throw new InvalidOperationException($"Unbalanced braces in '{signatureFragment}'.");
    }

    private static int At(string body, string marker, string what)
    {
        var at = body.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(at >= 0, $"{what}: '{marker}' not found.");
        return at;
    }

    [Fact]
    public void Ribbon_refresh_falls_back_only_after_observe_and_revalidate_leave_no_target()
    {
        var body = Body(Controller(), "private void RefreshEnablement()");
        var observe = At(body, "_undoTarget.Observe(doc)", "observe");
        var revalidate = At(body, "_undoTarget.Revalidate(", "revalidate");
        var fallback = At(body, "RecoverUndoTargetFromWorkspace(\"refresh\")", "fallback");
        var evaluate = At(body, "RibbonCommandPolicy.Evaluate(", "policy");
        Assert.True(observe < revalidate && revalidate < fallback && fallback < evaluate);

        At(body, "_undoTarget.Current is null && _connection.CurrentSession is not null", "fallback guard");
        At(body, "hasRememberedUndoTarget: _undoTarget.Current is not null || recovered is not null", "enablement");
    }

    [Fact]
    public void Undo_target_prefers_the_active_document_then_the_remembered_target_then_the_fallback()
    {
        var body = Body(Controller(), "private (ManagedFileRef? File, string Label) ResolveUndoTarget()");
        var active = At(body, "LocalCheckoutState.CheckedOutByMe", "active document");
        var remembered = At(body, "_undoTarget.Current is { } target", "remembered target");
        var fallback = At(body, "RecoverUndoTargetFromWorkspace(\"resolve\")", "fallback");
        Assert.True(active < remembered && remembered < fallback);
    }

    [Fact]
    public void Undo_still_confirms_locks_and_runs_the_orchestrator_after_resolving_the_target()
    {
        var body = Body(Controller(), "private void RunUndoCheckout()");
        var resolve = At(body, "ResolveUndoTarget()", "resolve");
        var origin = At(body, "EnsureWorkspaceServer(file.WorkspaceRoot, \"Undo Checkout\")", "origin check");
        var confirm = At(body, "will DISCARD your local changes", "confirmation");
        var cancel = At(body, "if (confirm != DialogResult.OK) return;", "cancel");
        var lockAt = At(body, "AcquireCommandLock(", "lock");
        var undo = At(body, "_connection.UndoCheckoutAsync(file", "orchestrator");
        Assert.True(resolve < origin && origin < confirm && confirm < cancel && cancel < lockAt && lockAt < undo);
    }

    [Fact]
    public void Fallback_reads_the_selected_workspace_only_and_never_writes_or_remembers()
    {
        var body = Body(Controller(), "private RememberedCheckoutTarget? RecoverUndoTargetFromWorkspace(string source)");
        At(body, "SafeLastWorkspaceRoot()", "selected workspace");
        At(body, "WorkspaceManifest.Load(root)", "manifest read");
        At(body, "status == WorkspaceManifestLoadStatus.Loaded", "only a readable manifest");
        At(body, "UndoTargetMemory.ResolveFromWorkspace(manifest.Entries, root, SafeFileExists)", "pure decision");

        foreach (var forbidden in new[] { "Save", "Delete", "Write", "_undoTarget.", "KnownWorkspaceRoots", "_connection." })
        {
            Assert.DoesNotContain(forbidden, body);
        }
    }

    [Fact]
    public void Undo_target_diagnostics_use_allowlisted_fields_and_log_transitions_only()
    {
        var body = Body(Controller(), "private void LogUndoTarget(");
        At(body, "\"pdm.undo-target\"", "operation");
        At(body, "_lastUndoTargetLog", "transition filter");

        var allowed = new[]
        {
            "Code(\"action\"", "Code(\"verdict\"", "Code(\"source\"", "Code(\"step\"",
            "Id(\"cadDocumentId\"", "Path(\"path\"", "Path(\"workspaceRoot\"", "Number(\"entryCount\"",
        };
        foreach (var field in allowed)
        {
            At(body, field, "field");
        }
        var fieldCount = System.Text.RegularExpressions.Regex.Matches(body, @"DiagnosticField\.\w+\(").Count;
        Assert.Equal(allowed.Length, fieldCount);
        Assert.DoesNotContain("Text(", body);
        Assert.DoesNotContain(".Message", body);
    }

    [Fact]
    public void Every_drop_of_the_remembered_target_is_logged_with_its_reason()
    {
        var source = Controller();
        At(Body(source, "private void RefreshEnablement()"), "LogUndoTarget(\"dropped\", dropReason", "revalidate drop");
        At(source, "LogUndoTarget(\"dropped\", \"signed-out\"", "sign-out drop");
    }
}
