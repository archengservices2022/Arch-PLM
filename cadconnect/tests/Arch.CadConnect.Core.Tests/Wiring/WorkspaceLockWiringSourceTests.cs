using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.Wiring;

/// <summary>
/// P6 M4.4 Phase 2 - MULTI-INSTANCE LOCK wiring. The Inventor controller
/// cannot be compiled into a test project, so (like the other wiring tests)
/// this reads its source and proves: the seven mutating entry points reach
/// exactly five lock acquisitions (Apply / Resume / Recover share the one
/// Copy Design attempt); each takes the right lock request; the order is
/// origin check -> (confirmation dialog) -> locks with the origin re-checked
/// while locked -> diagnostics -> background work; no server request comes
/// before the locks; the work runs through the locked runner, which releases
/// in the work's own finally; a failure before queueing releases through the
/// start scope; and read-only commands take no lock at all. The gate's
/// behavior itself is tested in Core (CommandLockGateTests).
/// </summary>
public class WorkspaceLockWiringSourceTests
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

    private static void InOrder(string body, string what, params string[] markers)
    {
        var previous = -1;
        foreach (var marker in markers)
        {
            var at = body.IndexOf(marker, previous + 1, StringComparison.Ordinal);
            Assert.True(at > previous, $"{what}: '{marker}' is missing or out of order.");
            previous = at;
        }
    }

    private const string Start = "using var releaseIfNotQueued = held.ReleaseUnlessQueued();";

    public static TheoryData<string, string, string, string?, string, string> DocumentCommands => new()
    {
        // method, command, origin guard, confirmation dialog, diagnostics start, server call
        { "private void RunCheckout()", "Checkout", "if (!EnsureWorkspaceServer(file.WorkspaceRoot, \"Checkout\")) return;", null,
            "PdmDiagnostics.StartFileCommand(", "_connection.CheckoutAsync(file, ct)" },
        { "private void RunCheckIn()", "Check In", "if (!EnsureWorkspaceServer(file.WorkspaceRoot, \"Check In\")) return;", "if (confirm != DialogResult.OK) return;",
            "PdmDiagnostics.StartFileCommand(", "_connection.CheckInAsync(file, ct)" },
        { "private void RunUndoCheckout()", "Undo Checkout", "if (!EnsureWorkspaceServer(file.WorkspaceRoot, \"Undo Checkout\")) return;", "if (confirm != DialogResult.OK) return;",
            "PdmDiagnostics.StartFileCommand(", "_connection.UndoCheckoutAsync(file, reason: null, ct)" },
    };

    [Theory]
    [MemberData(nameof(DocumentCommands))]
    public void Each_document_command_locks_its_workspace_after_the_origin_check_and_dialog_and_before_its_server_call(
        string method, string command, string originGuard, string? dialog, string diagnostics, string serverCall)
    {
        var body = Body(Controller(), method);
        var markers = new List<string> { originGuard };
        if (dialog is not null) markers.Add(dialog);
        markers.AddRange(new[]
        {
            "if (AcquireCommandLock(",
            $"Core.Workspace.Locking.WorkspaceLockRequest.ForDocument(\"{command}\", file.AbsoluteFilePath)",
            $"() => EnsureWorkspaceServer(file.WorkspaceRoot, \"{command}\")) is not {{ }} held) return;",
            Start,
            diagnostics,
            "held.AttachDiagnostics(log);",
            "RunLockedInBackground(",
            "held,",
            serverCall,
        });
        InOrder(body, method, markers.ToArray());
        Assert.DoesNotContain("RunBackground(", body.Replace("RunLockedInBackground(", ""));
    }

    [Fact]
    public void Get_Latest_locks_its_target_after_the_admission_check_and_rechecks_without_remembering()
    {
        var body = Body(Controller(), "private void ShowGetLatestDialog()");

        InOrder(body, "Get Latest",
            "WorkspaceServerBinding.AdmitGetLatestTarget(",
            "if (!target.Allowed)",
            "return;",
            "if (AcquireCommandLock(",
            "Core.Workspace.Locking.WorkspaceLockRequest.ForGetLatest(\"Get Latest\", workspaceRoot)",
            "() => GetLatestTargetAllowed(workspaceRoot)) is not { } held) return;",
            Start,
            "PdmDiagnostics.StartGetLatest(",
            "held.AttachDiagnostics(log);",
            "RunLockedInBackground(",
            "held,",
            "_connection.GetLatestAsync(request, ct)");
        Assert.DoesNotContain("RunBackground(", body.Replace("RunLockedInBackground(", ""));

        var recheck = Body(Controller(), "private bool GetLatestTargetAllowed(string workspaceRoot)");
        Assert.Contains("WorkspaceServerBinding.CheckGetLatestTarget(workspaceRoot, _connection.CurrentSession?.Server, _connection.CurrentSession?.Identity.OrganizationId)", recheck);
        Assert.DoesNotContain("Save()", recheck);
        Assert.Contains("RefusalDiagnostics.WorkspaceOrigin(_diagnostics, \"Get Latest\", target);", recheck);
    }

    [Fact]
    public void A_Copy_Design_attempt_locks_operation_destinations_and_workspaces_after_every_guard_and_before_its_work()
    {
        var body = Body(Controller(), "private void ExecuteCopyDesignAttempt(");

        InOrder(body, "Copy Design",
            "if (_connection.CurrentSession is not { } boundSession)",
            "if (CopyDesignRunning)",
            "bool OriginChecksPass()",
            "if (!OriginChecksPass()) return;",
            "Core.Workspace.Locking.WorkspaceLockRequest.ForCopyDesign(",
            "commandName,",
            "boundSession.Server.OriginString,",
            "idempotencyKey,",
            "plan.Nodes.Where(n => n.IsResolved && !string.IsNullOrWhiteSpace(n.SourceAbsolutePath)).Select(n => n.SourceAbsolutePath).ToArray(),",
            "destinations);",
            "if (AcquireCommandLock(lockRequest, OriginChecksPass) is not { } held) return;",
            Start,
            "Core.Diagnostics.CopyDesignDiagnostics.Start(",
            "held.AttachDiagnostics(log);",
            "new Core.CopyDesign.Apply.CopyDesignApplyOrchestrator(",
            "Volatile.Write(ref _copyDesignRunning, 1);",
            "RunCopyDesignAttemptInBackground();",
            "void RunCopyDesignAttemptInBackground() => RunLockedInBackground(",
            "held,",
            "result = await orchestrator.ExecuteAsync(");

        // the origin checks cover the source workspace and every destination workspace, bound to the attempt's session
        var checks = Body(body, "bool OriginChecksPass()");
        Assert.Contains("EnsureWorkspaceServer(WorkspaceRootLocator.FindRootForFile(plan.RootAbsolutePath), commandName, boundSession)", checks);
        Assert.Contains("EnsureWorkspaceServer(destinationRoot, commandName, boundSession)", checks);
        Assert.DoesNotContain("RunBackground(", body.Replace("RunLockedInBackground(", ""));
    }

    [Fact]
    public void The_seven_entry_points_reach_exactly_five_lock_acquisitions()
    {
        var source = Controller();

        var calls = Regex.Matches(source, @"AcquireCommandLock\(").Count;
        Assert.Equal(1 + 5, calls); // the helper + five call sites
        foreach (var method in new[]
        {
            "private void RunCheckout()", "private void RunCheckIn()", "private void RunUndoCheckout()",
            "private void ShowGetLatestDialog()", "private void ExecuteCopyDesignAttempt(",
        })
        {
            Assert.Single(Regex.Matches(Body(source, method), @"AcquireCommandLock\("));
        }
        // Apply, both Resumes and Recover all run through ExecuteCopyDesignAttempt - never their own lock.
        foreach (var method in new[]
        {
            "private void RunCopyDesignApply(", "private void RunCopyDesignResume()", "private void RunCopyDesignRecover()",
            "private void FinishDurableCopyDesignResume(", "private void RunDurableCopyDesignResume()",
        })
        {
            var body = Body(source, method);
            Assert.DoesNotContain("AcquireCommandLock(", body);
            Assert.DoesNotContain("RunLockedInBackground(", body);
        }
    }

    [Theory]
    [InlineData("private void RunCheckout()", "if (AcquireCommandLock(")]
    [InlineData("private void RunCheckIn()", "if (AcquireCommandLock(")]
    [InlineData("private void RunUndoCheckout()", "if (AcquireCommandLock(")]
    [InlineData("private void ShowGetLatestDialog()", "if (AcquireCommandLock(")]
    [InlineData("private void ExecuteCopyDesignAttempt(", "if (AcquireCommandLock(")]
    public void No_server_request_is_made_before_the_locks(string method, string lockCall)
    {
        var body = Body(Controller(), method);
        var locked = At(body, lockCall, method);

        Assert.DoesNotMatch(new Regex(@"_connection\.\w+Async\("), body[..locked]);
    }

    [Fact]
    public void The_locked_runner_hands_the_work_to_the_background_runner_through_the_lock()
    {
        // expression-bodied: the whole runner is this one hand-off
        Assert.Matches(new Regex(
            @"private void RunLockedInBackground\([^)]*\)\s*=>\s*held\.Queue\(locked => RunBackground\(locked, title, onDone, onSettled, timeout\), work\);"),
            Controller());

        var acquire = Body(Controller(), "private Core.Workspace.Locking.CommandLock? AcquireCommandLock(");
        InOrder(acquire, "AcquireCommandLock",
            "_locks.Admit(request, originAllowed)",
            "if (admission.Lock is { } held)",
            "return held;",
            "if (admission.LockRefusal is { } refusal)",
            "Error($\"{request.Command} was not run. {Core.Workspace.Locking.WorkspaceLockMessages.Describe(refusal)}\");",
            "return null;");
    }

    [Fact]
    public void The_gate_uses_the_real_Windows_locks_and_the_shared_diagnostics_log()
    {
        var source = Controller();

        Assert.Contains("Core.Workspace.Locking.WindowsLockPathSystem.Instance", source);
        Assert.Contains("Core.Workspace.Locking.WindowsLockHandleFactory.Instance", source);
        Assert.Matches(new Regex(@"new Core\.Workspace\.Locking\.CommandLockGate\(\s*new Core\.Workspace\.Locking\.WorkspaceLockAcquirer\([\s\S]*?\),\s*_diagnostics\);"), source);
        Assert.Single(Regex.Matches(source, @"new Core\.Workspace\.Locking\.CommandLockGate\("));
    }

    [Theory]
    [InlineData("private void RunCopyDesignPreview()")]
    [InlineData("private void RunCopyDesignVerify()")]
    [InlineData("private void RunReferenceHealth()")]
    [InlineData("private void RunScanReferences()")]
    [InlineData("private void ShowSignInDialog()")]
    public void Read_only_commands_take_no_lock(string method)
    {
        var body = Body(Controller(), method);

        Assert.DoesNotContain("AcquireCommandLock(", body);
        Assert.DoesNotContain("RunLockedInBackground(", body);
        Assert.DoesNotContain("_locks.", body);
    }

    /// <summary>M4.4 review decision: Repair Reference (P5C) changes ONE
    ///  reference of the document LOADED IN INVENTOR - it writes no file, no
    ///  attribute and no workspace manifest, and its server calls are reads.
    ///  The target file is protected by P5C's own read lease across the
    ///  mutation. It therefore takes no M4.4 lock (a workspace lock would have
    ///  to span its in-coordinator confirmation dialog). These tests keep that
    ///  decision honest: the day it writes to disk, they fail.</summary>
    [Theory]
    [InlineData("private void RunRepairReference()")]
    [InlineData("private void ContinueRepairReference(")]
    [InlineData("private void BeginFinalRepairPreflight(")]
    [InlineData("private void CompleteFinalRepairPreflight(")]
    public void Repair_Reference_takes_no_workspace_lock_and_writes_nothing_to_disk(string method)
    {
        var body = Body(Controller(), method);

        Assert.DoesNotContain("AcquireCommandLock(", body);
        Assert.DoesNotMatch(new Regex(@"\.Save2?\(|SaveAtomic\(|File\.(Write|Copy|Move|Delete|SetAttributes)|ManagedFileGuard\."), body);
    }

    [Fact]
    public void Repair_Reference_mutates_only_in_memory_under_its_protected_target_lease()
    {
        var references = Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "References");
        foreach (var file in new[] { "InventorReferenceReplacer.cs", "InventorRepairPreflight.cs" })
        {
            var code = string.Join('\n', File.ReadAllLines(Path.Combine(references, file))
                .Where(l => !l.TrimStart().StartsWith("//", StringComparison.Ordinal)));
            Assert.DoesNotMatch(new Regex(@"\.Save2?\(|SaveAtomic\(|File\.(Write|Copy|Move|Delete|SetAttributes)|FileAccess\.(Write|ReadWrite)"), code);
        }
        var preflight = File.ReadAllText(Path.Combine(references, "InventorRepairPreflight.cs"));
        Assert.Contains("new FileStream(absolutePath, FileMode.Open, FileAccess.Read, FileShare.Read)", preflight);

        var coordinator = File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Core", "References", "Repair", "ReferenceRepairCoordinator.cs"));
        InOrder(coordinator, "repair coordinator",
            "confirmation.Confirm(plan)",
            "preflight.AcquireProtectedTargetForMutation(plan, verdict)",
            "replace = prepared.Execute();",
            "finally",
            "lease.Dispose();");
    }

    [Fact]
    public void Only_the_acquisition_helper_touches_the_gate()
    {
        var source = Controller();

        Assert.Single(Regex.Matches(source, @"_locks\.Admit\("));
        Assert.Equal(3, Regex.Matches(source, @"\b_locks\b").Count); // the field, its construction, the one Admit call
    }
}
