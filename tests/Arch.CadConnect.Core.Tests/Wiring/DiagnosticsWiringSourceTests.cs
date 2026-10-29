using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.Wiring;

/// <summary>
/// P6 M4.2 - DIAGNOSTICS wiring. The Inventor controller cannot be compiled
/// into a test project, so (like the other wiring tests) this reads its
/// source and proves every in-scope command - Copy Design Apply / Resume /
/// Recover, Get Latest, Checkout, Check In, Undo Checkout - starts a log,
/// records its result AND any thrown failure (rethrowing it unchanged), that
/// every workspace-origin refusal is logged, and that nothing ever reads the
/// log back. The recorders' behavior is tested in Core/Api directly.
/// </summary>
public class DiagnosticsWiringSourceTests
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
    public void The_controller_logs_to_the_default_folder_and_shares_the_log_with_the_connection_manager()
    {
        var source = Controller();

        Assert.Contains("new Core.Diagnostics.JsonLinesDiagnosticsSink(Core.Diagnostics.JsonLinesDiagnosticsSink.DefaultDirectory)", source);
        Assert.Contains("_connection.Diagnostics = _diagnostics;", source);
    }

    [Theory]
    [InlineData("private void RunCheckout()", "Checkout", "\"Checkout\")) return;", "_connection.CheckoutAsync(file, ct)", "RecordCheckout")]
    [InlineData("private void RunCheckIn()", "CheckIn", "\"Check In\")) return;", "_connection.CheckInAsync(file, ct)", "RecordCheckIn")]
    [InlineData("private void RunUndoCheckout()", "UndoCheckout", "\"Undo Checkout\")) return;", "_connection.UndoCheckoutAsync(file, reason: null, ct)", "RecordUndo")]
    public void Each_document_command_logs_start_result_and_failure_around_its_one_server_call(
        string method, string operation, string guard, string call, string recorder)
    {
        var body = Body(Controller(), method);

        var guarded = At(body, guard, method);
        var start = At(body, $"PdmDiagnostics.StartFileCommand(_diagnostics, PdmDiagnostics.{operation}Operation, file, _connection.CurrentSession)", method);
        var background = At(body, "RunLockedInBackground(", method); // M4.4: the locked runner
        var server = At(body, call, method);
        var record = At(body, $"PdmDiagnostics.{recorder}(log, result);", method);
        var failure = At(body, "PdmDiagnostics.RecordException(log, ex);", method);
        Assert.True(guarded < start && start < background && background < server && server < record && record < failure, method);
        Assert.Matches(new Regex(@"PdmDiagnostics\.RecordException\(log, ex\);\s*throw;"), body);
    }

    [Fact]
    public void Get_Latest_logs_its_refusal_and_its_start_result_and_failure()
    {
        var body = Body(Controller(), "private void ShowGetLatestDialog()");

        var refused = At(body, "if (!target.Allowed)", "refusal");
        var logged = At(body, "Core.Diagnostics.RefusalDiagnostics.WorkspaceOrigin(_diagnostics, \"Get Latest\", target);", "refusal log");
        var error = At(body, "Error($\"Get Latest was not run.", "refusal message");
        Assert.True(refused < logged && logged < error);

        var start = At(body, "PdmDiagnostics.StartGetLatest(_diagnostics, request, _connection.CurrentSession)", "start");
        var server = At(body, "_connection.GetLatestAsync(request, ct)", "request");
        var record = At(body, "PdmDiagnostics.RecordGetLatest(log, report);", "result");
        Assert.True(error < start && start < server && server < record);
        Assert.Matches(new Regex(@"PdmDiagnostics\.RecordException\(log, ex\);\s*throw;"), body);
    }

    [Fact]
    public void Every_workspace_origin_guard_logs_its_refusal_before_reporting_it()
    {
        var source = Controller();

        foreach (var signature in new[]
        {
            "private bool EnsureWorkspaceServer(string? workspaceRoot, string commandName, ArchServerUri? server)",
            "private bool EnsureWorkspaceServer(string? workspaceRoot, string commandName, Action rememberSettingsWhenAllowed)",
        })
        {
            var body = Body(source, signature);
            var logged = At(body, "Core.Diagnostics.RefusalDiagnostics.WorkspaceOrigin(_diagnostics, commandName, binding);", signature);
            var error = At(body, "Error($\"{commandName} was not run. {binding.Message}\");", signature);
            Assert.True(logged < error, signature);
        }
    }

    [Fact]
    public void A_Copy_Design_attempt_logs_its_refusals_start_progress_result_and_failure()
    {
        var body = Body(Controller(), "private void ExecuteCopyDesignAttempt(");

        Assert.Matches(new Regex(@"RefusalDiagnostics\.Command\(_diagnostics, commandName, Core\.Diagnostics\.RefusalDiagnostics\.NotSignedIn\);\s*Error\("), body);
        Assert.Matches(new Regex(@"RefusalDiagnostics\.Command\(_diagnostics, commandName, Core\.Diagnostics\.RefusalDiagnostics\.AlreadyRunning\);\s*Error\("), body);

        var lastGuard = body.LastIndexOf("EnsureWorkspaceServer(destinationRoot, commandName, boundSession.Server)", StringComparison.Ordinal);
        var start = At(body, "CopyDesignDiagnostics.Start(", "start");
        var orchestrator = At(body, "new Core.CopyDesign.Apply.CopyDesignApplyOrchestrator(", "orchestrator");
        var progress = At(body, "progress: Core.Diagnostics.CopyDesignDiagnostics.Progress(log));", "progress");
        var execute = At(body, "result = await orchestrator.ExecuteAsync(", "execute");
        var record = At(body, "Core.Diagnostics.CopyDesignDiagnostics.RecordResult(log, result);", "result");
        Assert.True(lastGuard >= 0 && lastGuard < start && start < orchestrator && orchestrator < progress && progress < execute && execute < record);
        Assert.Contains("_diagnostics, kind.ToString(), plan, idempotencyKey, boundSession, confirmedFingerprint);", body);
        Assert.Matches(new Regex(@"log\.Failed\(ex\);\s*throw;"), body);
    }

    [Fact]
    public void Nothing_ever_reads_the_diagnostics_log_back()
    {
        var src = Path.Combine(RepoRoot(), "src");
        var users = Directory.EnumerateFiles(src, "*.cs", SearchOption.AllDirectories)
            .Where(f => !f.Contains(Path.Combine("bin", ""), StringComparison.OrdinalIgnoreCase) && !f.Contains(Path.Combine("obj", ""), StringComparison.OrdinalIgnoreCase))
            .Where(f => File.ReadAllText(f).Contains("JsonLinesDiagnosticsSink", StringComparison.Ordinal))
            .Select(f => Path.GetFileName(f))
            .OrderBy(f => f, StringComparer.Ordinal)
            .ToArray();

        // Only the writer itself and the one place that constructs it.
        Assert.Equal(new[] { "ArchAddInController.cs", "DiagnosticsAttempt.cs", "JsonLinesDiagnosticsSink.cs" }, users);
        var controller = Controller();
        Assert.DoesNotMatch(new Regex(@"DefaultDirectory[^;]*(ReadAll|EnumerateFiles|GetFiles|OpenRead)"), controller);
    }
}
