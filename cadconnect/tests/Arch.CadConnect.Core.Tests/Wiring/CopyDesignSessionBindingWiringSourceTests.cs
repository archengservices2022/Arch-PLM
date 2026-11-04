using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.Wiring;

/// <summary>
/// P6 M4.1a - SESSION BINDING + CONNECTION LOCK wiring. The Inventor
/// controller cannot be compiled into a test project, so (like
/// <see cref="ServerOriginGuardWiringSourceTests"/>) this reads the source as
/// text and proves:
///   - every Copy Design adapter calls the SESSION-BOUND connection overloads
///     with the session captured when the attempt started;
///   - the attempt's busy flag is set before the work is queued and cleared in
///     the work's <c>finally</c>;
///   - the command handler itself (not only the ribbon) refuses commands
///     while Copy Design runs;
///   - in the connection manager, check and dispatch run under the same gate
///     every session change takes, and the request is addressed with the
///     BOUND session.
/// The behavior itself is tested in Arch.CadConnect.Api.Tests
/// (ArchConnectionManagerTests, "M4.1a session binding").
/// </summary>
public class CopyDesignSessionBindingWiringSourceTests
{
    private static string RepoRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", ".."));

    private static string Controller() =>
        File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Inventor", "ArchAddInController.cs"));

    private static string ConnectionManager() =>
        File.ReadAllText(Path.Combine(RepoRoot(), "src", "Arch.CadConnect.Api", "ArchConnectionManager.cs"));

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

    private static int IndexOrFail(string body, string marker, string what)
    {
        var at = body.IndexOf(marker, StringComparison.Ordinal);
        Assert.True(at >= 0, $"{what}: '{marker}' not found.");
        return at;
    }

    [Theory]
    [InlineData("ApplyCopyDesignReservationAdapter", "connection.ApplyCopyDesignAsync(request, boundSession, ct)")]
    [InlineData("MaterializeCopyDesignAdapter", "connection.MaterializeFirstFileVersionAsync(request, boundSession, ct)")]
    [InlineData("CopyDesignOperationStatusAdapter", "connection.GetCopyDesignOperationStatusAsync(expectation, boundSession, ct)")]
    public void Every_copy_design_adapter_uses_the_session_bound_overload(string adapter, string boundCall)
    {
        var body = Body(Controller(), $"private sealed class {adapter}(ArchConnectionManager connection, IArchSession boundSession)");

        Assert.Contains(boundCall, body);
    }

    [Fact]
    public void No_copy_design_server_call_in_the_controller_uses_an_unbound_overload()
    {
        var source = Controller();

        Assert.DoesNotMatch(new Regex(@"\.ApplyCopyDesignAsync\(request, ct\)"), source);
        Assert.DoesNotMatch(new Regex(@"\.MaterializeFirstFileVersionAsync\(request, ct\)"), source);
        Assert.DoesNotMatch(new Regex(@"\.GetCopyDesignOperationStatusAsync\(expectation, ct\)"), source);
    }

    [Fact]
    public void The_attempt_captures_the_session_first_and_checks_the_workspace_against_THAT_session()
    {
        var body = Body(Controller(), "private void ExecuteCopyDesignAttempt(");

        var capture = IndexOrFail(body, "_connection.CurrentSession is not { } boundSession", "session capture");
        var check = IndexOrFail(body, "commandName, boundSession)", "workspace check");
        var orchestrator = IndexOrFail(body, "new Core.CopyDesign.Apply.CopyDesignApplyOrchestrator(", "orchestrator");
        Assert.True(capture < check && check < orchestrator);
        Assert.Contains("new ApplyCopyDesignReservationAdapter(_connection, boundSession)", body);
        Assert.Contains("new MaterializeCopyDesignAdapter(_connection, boundSession)", body);
        Assert.Contains("new CopyDesignOperationStatusAdapter(_connection, boundSession)", body);
    }

    [Fact]
    public void The_busy_flag_is_set_before_the_work_is_queued_and_cleared_in_the_works_finally()
    {
        var body = Body(Controller(), "private void ExecuteCopyDesignAttempt(");

        var set = IndexOrFail(body, "Volatile.Write(ref _copyDesignRunning, 1);", "busy set");
        var queued = IndexOrFail(body, "RunCopyDesignAttemptInBackground();", "work queued");
        Assert.True(set < queued);

        var work = body[body.IndexOf("void RunCopyDesignAttemptInBackground()", StringComparison.Ordinal)..];
        // The run's own try (M4.2 adds the log calls and a catch inside it)
        // ends in the finally that clears the flag - the first finally after
        // ExecuteAsync.
        Assert.Matches(new Regex(
            @"try\s*\{\s*result = await orchestrator\.ExecuteAsync\([^;]*\);(?:(?!finally)[\s\S])*\}\s*finally\s*\{\s*Volatile\.Write\(ref _copyDesignRunning, 0\);"),
            work);
        // ... and a failure to even queue the work clears it too.
        Assert.Matches(new Regex(@"catch\s*\{\s*Volatile\.Write\(ref _copyDesignRunning, 0\);\s*RefreshEnablement\(\);\s*throw;"), body);
    }

    [Fact]
    public void The_command_handler_refuses_blocked_commands_before_dispatching_any_of_them()
    {
        var body = Body(Controller(), "private void OnCommandInvoked(ArchCommand command)");

        var refusal = IndexOrFail(body,
            "if (CopyDesignRunning && !RibbonCommandPolicy.IsAllowedWhileCopyDesignRuns(command))", "handler refusal");
        var dispatch = IndexOrFail(body, "switch (command)", "dispatch");
        Assert.True(refusal < dispatch);
        Assert.Contains("return;", body[refusal..dispatch]);
    }

    [Fact]
    public void The_ribbon_is_told_when_Copy_Design_is_running()
    {
        Assert.Contains("copyDesignRunning: CopyDesignRunning", Body(Controller(), "private void RefreshEnablement()"));
    }

    [Fact]
    public void Bound_dispatch_checks_and_sends_under_the_session_gate_with_the_BOUND_session()
    {
        var body = Body(ConnectionManager(), "private async Task<T> WithBoundSessionAsync<T>(");

        var wait = IndexOrFail(body, "await _sessionGate.WaitAsync(ct)", "gate");
        var check = IndexOrFail(body, "if (!ReferenceEquals(CurrentSession, boundSession))", "check");
        var send = IndexOrFail(body, "await op(_apiFactory(boundSession.Server), boundSession)", "dispatch");
        var release = IndexOrFail(body, "_sessionGate.Release();", "release");
        Assert.True(wait < check && check < send && send < release);
        Assert.DoesNotContain("_apiFactory(CurrentSession", body);
    }

    [Fact]
    public void Every_session_change_takes_the_session_gate()
    {
        var source = ConnectionManager();

        var setSession = Body(source, "private void SetSession(IArchSession? session)");
        Assert.True(setSession.IndexOf("_sessionGate.Wait();", StringComparison.Ordinal)
            < setSession.IndexOf("CurrentSession = session;", StringComparison.Ordinal));
        var invalidate = Body(source, "private void InvalidateRejectedSessionIfCurrent(IArchSession rejected)");
        Assert.Contains("_sessionGate.Wait();", invalidate);

        // CurrentSession is assigned nowhere else.
        var assignments = Regex.Matches(source, @"CurrentSession = ").Count;
        Assert.Equal(2, assignments);
    }
}
