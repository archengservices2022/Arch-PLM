using System.Text.RegularExpressions;

namespace Arch.CadConnect.Core.Tests.Wiring;

/// <summary>P6 M4.4 Package C R9: the calling contract of the entrypoints that
///  carry no workspace. They cannot check one themselves, so every path to them
///  must pass the guard first, and with the organization, not just the server.
///  Read from the source, as the add-in itself cannot run here.</summary>
public class PackageCGuardWiringTests
{
    private static string Src(params string[] parts)
    {
        var dir = AppContext.BaseDirectory;
        while (dir is not null && !File.Exists(Path.Combine(dir, "Arch.CadConnect.sln")))
        {
            dir = Path.GetDirectoryName(dir);
        }
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(new[] { dir!, "src" }.Concat(parts).ToArray()));
    }

    private static string Controller() => Src("Arch.CadConnect.Inventor", "ArchAddInController.cs");

    [Fact]
    public void Every_binding_check_in_the_controller_and_the_manager_passes_the_organization()
    {
        foreach (var source in new[] { Controller(), Src("Arch.CadConnect.Api", "ArchConnectionManager.cs") })
        {
            var calls = Regex.Matches(source, @"WorkspaceServerBinding\.(CheckWorkspace|CheckGetLatestTarget)\(([^;]*?)\)\s*(\.Allowed\)|\)|;)");
            Assert.NotEmpty(calls);
            Assert.All(calls.Select(c => c.Groups[2].Value), arguments => Assert.Contains("OrganizationId", arguments));
        }
    }

    [Fact]
    public void Get_Latest_admission_passes_the_organization()
    {
        Assert.Matches(new Regex(@"AdmitGetLatestTarget\([^;]*connectedOrganization:[^;]*OrganizationId", RegexOptions.Singleline), Controller());
    }

    [Fact]
    public void Copy_Design_checks_source_and_destination_against_the_bound_session_before_and_under_its_locks()
    {
        var source = Controller();

        Assert.Contains("WorkspaceRootLocator.FindRootForFile(plan.RootAbsolutePath), commandName, boundSession)", source);
        Assert.Contains("EnsureWorkspaceServer(destinationRoot, commandName, boundSession)", source);
        Assert.Contains("if (!OriginChecksPass()) return;", source);
        Assert.Contains("AcquireCommandLock(lockRequest, OriginChecksPass)", source);
    }

    [Theory]
    [InlineData("GetDrawingAssociationsAsync")]
    [InlineData("ApplyCopyDesignAsync")]
    [InlineData("MaterializeFirstFileVersionAsync")]
    public void A_call_with_no_workspace_reaches_the_api_only_through_the_connection_manager(string method)
    {
        var callers = Regex.Matches(Controller(), $@"(\w+)\.{method}\(").Select(m => m.Groups[1].Value).ToList();

        Assert.NotEmpty(callers);
        Assert.All(callers, caller => Assert.EndsWith("connection", caller));
    }

    [Fact]
    public void Nothing_promotes_or_restores_an_artifact_after_a_restart()
    {
        Assert.DoesNotContain("RestoreInterruptedSave", Src("Arch.CadConnect.Core", "Workspace", "WorkspaceManifest.cs"));
        Assert.DoesNotContain("RestoreInterruptedSave", Src("Arch.CadConnect.Api", "Workspace", "GetLatestOrchestrator.cs"));
    }

    [Fact]
    public void The_recovery_records_are_settled_only_after_the_binding_was_checked()
    {
        var source = Src("Arch.CadConnect.Api", "Workspace", "GetLatestOrchestrator.cs");

        var inspected = source.IndexOf("WorkspaceRecoveryState.Inspect(", StringComparison.Ordinal);
        var loaded = source.IndexOf("WorkspaceManifest.Load(", StringComparison.Ordinal);
        var bound = source.IndexOf("WorkspaceServerBinding.Evaluate(", StringComparison.Ordinal);
        var settled = source.IndexOf("RecoverInterruptedReplacements(", StringComparison.Ordinal);
        var requested = source.IndexOf("await _resolve(", StringComparison.Ordinal);

        Assert.True(inspected > 0 && inspected < loaded && loaded < bound && bound < settled && settled < requested);
    }
}
