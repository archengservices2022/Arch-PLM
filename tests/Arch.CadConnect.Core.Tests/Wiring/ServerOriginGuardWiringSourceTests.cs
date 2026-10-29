using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.Wiring;

/// <summary>
/// P6 M4.1 SERVER-ORIGIN GUARD - command entry-point coverage. The Inventor
/// controller cannot be compiled into a test project (COM/WinForms), so this
/// reads <c>ArchAddInController.cs</c> as text (the same fallback as
/// <see cref="CopyDesignVerifyWiringSourceTests"/>) and proves that EVERY
/// document-scoped command checks the workspace's server binding BEFORE its
/// first server call, dialog or orchestrator - and that no new server call can
/// be added to the controller without this inventory being updated.
/// </summary>
public class ServerOriginGuardWiringSourceTests
{
    private const string Guard = "EnsureWorkspaceServer(";

    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", ".."));

    private static string Controller() =>
        File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "ArchAddInController.cs"));

    private static string Body(string source, string signatureFragment)
    {
        var start = source.IndexOf(signatureFragment, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Could not locate '{signatureFragment}' in the controller.");
        var open = source.IndexOf('{', start);
        var depth = 0;
        for (var i = open; i < source.Length; i++)
        {
            if (source[i] == '{') depth++;
            else if (source[i] == '}' && --depth == 0) return source[open..(i + 1)];
        }
        throw new InvalidOperationException($"Unbalanced braces in '{signatureFragment}'.");
    }

    /// <summary>The guard must appear, and appear BEFORE the first of
    ///  <paramref name="laterMarkers"/> that exists in the body.</summary>
    private static void AssertGuardPrecedes(string body, string method, string guard, params string[] laterMarkers)
    {
        var guardAt = body.IndexOf(guard, StringComparison.Ordinal);
        Assert.True(guardAt >= 0, $"{method} does not call the server-origin guard ({guard}).");
        var first = laterMarkers
            .Select(m => body.IndexOf(m, StringComparison.Ordinal))
            .Where(i => i >= 0)
            .DefaultIfEmpty(-1)
            .Min();
        Assert.True(first >= 0, $"{method}: none of the expected later markers were found - update this test.");
        Assert.True(guardAt < first, $"{method} calls the server-origin guard only AFTER a server call / dialog.");
    }

    [Fact]
    public void The_controller_guard_delegates_to_the_core_binding_with_the_connected_server_and_refuses_on_failure()
    {
        var source = Controller();
        // The usual overload checks against the CONNECTED server; M4.1a's
        // overload takes an explicit (bound) server and does the work.
        Assert.Contains(
            "private bool EnsureWorkspaceServer(string? workspaceRoot, string commandName) =>\r\n"
            + "        EnsureWorkspaceServer(workspaceRoot, commandName, _connection.CurrentSession?.Server);",
            source.Replace("\r\n", "\n").Replace("\n", "\r\n"));
        var body = Body(source, "private bool EnsureWorkspaceServer(string? workspaceRoot, string commandName, ArchServerUri? server)");

        Assert.Contains("WorkspaceServerBinding.CheckWorkspace(workspaceRoot, server)", body);
        Assert.Contains("Error(", body);
        Assert.Contains("return false;", body);
    }

    public static TheoryData<string, string> GuardedEntryPoints => new()
    {
        // method signature fragment            , first server call / dialog that must come after the guard
        { "private void RunCheckout()",            "_connection.CheckoutAsync(" },
        { "private void RunCheckIn()",             "MessageBox.Show(" },
        { "private void RunUndoCheckout()",        "_connection.UndoCheckoutAsync(" },
        { "private void RunReferenceHealth()",     "_connection.GetLatestVersionsAsync(" },
        { "private void RunCopyDesignPreview()",   "new CopyDesignPreviewDialog(" },
        { "private void RunDurableCopyDesignResume()", "_connection.GetDurableCopyDesignOperationStatusAsync(" },
        { "private void RunCopyDesignVerify()",    "_connection.GetCopyDesignVerificationSupportAsync(" },
        { "private void RunRepairReference()",     "_connection.GetLatestVersionsAsync(" },
        { "private void BeginFinalRepairPreflight(", "_connection.GetLatestVersionsAsync(" },
        { "private void ExecuteCopyDesignAttempt(", "new Core.CopyDesign.Apply.CopyDesignApplyOrchestrator(" },
    };

    [Theory]
    [MemberData(nameof(GuardedEntryPoints))]
    public void Every_document_scoped_entry_point_checks_the_server_binding_before_contacting_the_server(string method, string firstServerContact)
    {
        var body = Body(Controller(), method);

        AssertGuardPrecedes(body, method, Guard, firstServerContact, "RunBackground(");
        var firstServerCall = Regex.Match(body, @"_connection\.\w+Async\(");
        Assert.True(!firstServerCall.Success || body.IndexOf(Guard, StringComparison.Ordinal) < firstServerCall.Index,
            $"{method} contacts the server before the server-origin guard.");
    }

    [Fact]
    public void RunCheckIn_guards_before_its_confirmation_and_before_the_server_call()
    {
        var body = Body(Controller(), "private void RunCheckIn()");

        AssertGuardPrecedes(body, "RunCheckIn", Guard, "_connection.CheckInAsync(");
    }

    [Theory]
    [InlineData("private void RunCopyDesignApply(")]
    [InlineData("private void RunCopyDesignResume()")]
    [InlineData("private void RunCopyDesignRecover()")]
    [InlineData("private void FinishDurableCopyDesignResume(")]  // durable Resume's final step, reached only from the guarded RunDurableCopyDesignResume
    public void Apply_resume_and_recover_all_execute_through_the_guarded_attempt(string method)
    {
        var body = Body(Controller(), method);

        Assert.Contains("ExecuteCopyDesignAttempt(", body);
        Assert.DoesNotContain("new Core.CopyDesign.Apply.CopyDesignApplyOrchestrator(", body);
    }

    [Fact]
    public void Only_ExecuteCopyDesignAttempt_constructs_the_apply_orchestrator()
    {
        var source = Controller();

        Assert.Single(Regex.Matches(source, @"new Core\.CopyDesign\.Apply\.CopyDesignApplyOrchestrator\("));
    }

    [Fact]
    public void The_copy_design_attempt_guard_checks_the_source_workspace_and_every_destination_workspace()
    {
        var body = Body(Controller(), "private void ExecuteCopyDesignAttempt(");

        Assert.Contains("WorkspaceRootLocator.FindRootForFile(plan.RootAbsolutePath)", body);
        Assert.Contains("ProposedDestinationAbsolutePath", body);
        Assert.Contains("CopyDesignAttemptKind.Resume => \"Resume Copy Design\"", body);
        Assert.Contains("CopyDesignAttemptKind.Recover => \"Recover Copy Design\"", body);
    }

    [Fact]
    public void Get_Latest_checks_the_target_folder_binding_before_the_request()
    {
        var body = Body(Controller(), "private void ShowGetLatestDialog()");

        AssertGuardPrecedes(body, "ShowGetLatestDialog",
            "WorkspaceServerBinding.AdmitGetLatestTarget(",
            "_connection.GetLatestAsync(", "RunBackground(");
        Assert.Contains("_connection.CurrentSession?.Server,", body);
    }

    /// <summary>M4.1 T4 finding: a refused Get Latest target must leave
    ///  connect.json untouched. The only save of the folder is the admission's
    ///  remember callback (which runs only when the check allows it) - the
    ///  dialog no longer saves on OK, and the controller saves nowhere else
    ///  in Get Latest.</summary>
    [Fact]
    public void Get_Latest_remembers_the_folder_only_through_the_admission_check()
    {
        var dialog = File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "Ui", "GetLatestDialog.cs"));
        Assert.DoesNotContain(".Save()", dialog);

        var body = Body(Controller(), "private void ShowGetLatestDialog()");
        var admit = body.IndexOf("WorkspaceServerBinding.AdmitGetLatestTarget(", StringComparison.Ordinal);
        var refusal = body.IndexOf("if (!target.Allowed)", StringComparison.Ordinal);
        Assert.True(admit >= 0 && refusal > admit);
        Assert.Contains(
            "rememberWorkspaceRoot: folder => (ConnectSettings.Load() with { LastWorkspaceRoot = folder }).Save());",
            body[admit..refusal]);
        Assert.Single(Regex.Matches(body, @"\.Save\(\)"));
        Assert.DoesNotContain("WorkspaceServerBinding.CheckGetLatestTarget(", body);
    }

    /// <summary>M4.1 T5 finding: a refused Resume / Verify source workspace
    ///  must leave connect.json untouched. Neither dialog saves anything any
    ///  more; each command remembers its folders ONLY through the admitting
    ///  guard overload (which runs the callback only when allowed), before
    ///  the first server lookup, and saves nowhere else.</summary>
    [Theory]
    [InlineData("private void RunDurableCopyDesignResume()", "Resume Copy Design",
        "rememberSettingsWhenAllowed: () => (ConnectSettings.Load() with { LastCopyDesignDestinationFolder = input.DestinationFolder }).Save())) return;",
        "_connection.GetDurableCopyDesignOperationStatusAsync(")]
    [InlineData("private void RunCopyDesignVerify()", "Verify Copy Design",
        "rememberSettingsWhenAllowed: () => (ConnectSettings.Load() with { LastWorkspaceRoot = input.SourceWorkspaceRoot, LastCopyDesignDestinationFolder = input.DestinationFolder }).Save())) return;",
        "_connection.GetCopyDesignVerificationSupportAsync(")]
    public void Resume_and_Verify_remember_folders_only_through_the_admitting_guard(
        string method, string commandName, string rememberCall, string firstLookup)
    {
        var body = Body(Controller(), method);

        var guard = body.IndexOf($"if (!EnsureWorkspaceServer(input.SourceWorkspaceRoot, \"{commandName}\",", StringComparison.Ordinal);
        var remember = body.IndexOf(rememberCall, StringComparison.Ordinal);
        var lookup = body.IndexOf(firstLookup, StringComparison.Ordinal);
        Assert.True(guard >= 0, $"{method}: admitting guard not found.");
        Assert.True(remember > guard, $"{method}: the settings save is not the guard's remember callback.");
        Assert.True(lookup > remember, $"{method}: settings must be remembered before the first server lookup.");
        Assert.Single(Regex.Matches(body, @"\.Save\(\)"));
    }

    [Theory]
    [InlineData("CopyDesignDurableResumeDialog.cs")]
    [InlineData("CopyDesignVerifyDialog.cs")]
    public void The_Resume_and_Verify_dialogs_never_save_settings(string dialog)
    {
        var source = File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "Ui", dialog));

        Assert.DoesNotContain(".Save()", source);
    }

    [Fact]
    public void The_admitting_guard_runs_the_remember_callback_only_through_AdmitWorkspace()
    {
        var body = Body(Controller(),
            "private bool EnsureWorkspaceServer(string? workspaceRoot, string commandName, Action rememberSettingsWhenAllowed)");

        Assert.Contains("WorkspaceServerBinding.AdmitWorkspace(", body);
        Assert.Contains("workspaceRoot, _connection.CurrentSession?.Server, rememberSettingsWhenAllowed)", body);
        Assert.Single(Regex.Matches(body, "rememberSettingsWhenAllowed"));  // passed on, never invoked directly here
        Assert.Contains("return false;", body);
    }

    /// <summary>INVENTORY: every server call the controller makes. A new one
    ///  fails this test until it is classified - either as session-level (no
    ///  workspace involved) or as reached only through a guarded entry point
    ///  above.</summary>
    [Fact]
    public void Every_server_call_in_the_controller_is_classified()
    {
        var sessionLevel = new[] { "TryRestoreAsync", "SignOutAsync", "RefreshServerStatusAsync", "SignInAsync" };
        var behindAGuard = new[]
        {
            "CheckoutAsync", "CheckInAsync", "UndoCheckoutAsync",          // + ArchConnectionManager re-checks
            "GetLatestAsync",                                               // + ArchConnectionManager re-checks
            "GetLatestVersionsAsync",                                       // Reference Health / Repair
            "GetCheckoutStatusAsync",                                       // Repair only (LoadCheckoutStatusesAsync)
            "GetDrawingAssociationsAsync",                                  // + ArchConnectionManager: NotAvailable on mismatch
            "GetDurableCopyDesignOperationStatusAsync",                     // durable Resume
            "GetCopyDesignVerificationSupportAsync",                        // Verify
        };

        var used = Regex.Matches(Controller(), @"_connection\.(\w+Async)\(")
            .Select(m => m.Groups[1].Value)
            .Distinct()
            .ToArray();

        var unclassified = used.Except(sessionLevel).Except(behindAGuard).ToArray();
        Assert.True(unclassified.Length == 0,
            "Unclassified server call(s) in ArchAddInController: " + string.Join(", ", unclassified)
            + ". Add the M4.1 server-origin guard to the calling command and classify it here.");
    }

    [Fact]
    public void Checkout_statuses_are_loaded_only_from_the_guarded_repair_flow()
    {
        var source = Controller();
        var callers = Regex.Matches(source, @"await LoadCheckoutStatusesAsync\(").Count;

        Assert.Equal(2, callers);
        Assert.Contains("await LoadCheckoutStatusesAsync(", Body(source, "private void RunRepairReference()"));
        Assert.Contains("await LoadCheckoutStatusesAsync(", Body(source, "private void BeginFinalRepairPreflight("));
    }

    [Fact]
    public void The_connection_manager_enforces_the_binding_on_every_workspace_carrying_call()
    {
        var source = File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Api", "ArchConnectionManager.cs"));

        foreach (var method in new[] { "CheckoutAsync", "CheckInAsync", "UndoCheckoutAsync" })
        {
            Assert.Matches(
                new Regex($@"public Task<Workspace\.\w+> {method}\(ManagedFileRef file[^)]*\)\s*=> WithSessionAsync\(\(api, s\) => \{{ RequireWorkspaceServer\(file, s\); return api\.{method}\("),
                source);
        }
        Assert.Contains("CheckGetLatestTarget(request.WorkspaceRoot, session.Server)", source);
        Assert.Contains("CheckWorkspace(WorkspaceRootOf(manifest), session.Server)", source);
    }
}
