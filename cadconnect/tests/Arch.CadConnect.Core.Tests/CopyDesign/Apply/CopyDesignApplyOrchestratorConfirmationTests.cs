using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

using static Arch.CadConnect.Core.Tests.CopyDesign.Apply.CopyDesignApplyFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// P6 Milestone 2: the orchestrator executes ONLY the mapping that was
/// confirmed - a stale or changed plan is refused before any server call or
/// physical mutation.
/// </summary>
public class CopyDesignApplyOrchestratorConfirmationTests
{
    private static CopyDesignNode Node(string destination) =>
        CopyNode("cad-1", @"D:\ArchPLM-Test\GetLatest\ARCH-TEST-001.ipt", destination, isRoot: true)
            with { SourceDocumentNumber = "ARCH-TEST-001.ipt" };

    [Fact]
    public async Task Executing_the_confirmed_plan_with_its_own_fingerprint_proceeds_normally()
    {
        var h = new OrchestratorHarness();
        var plan = Plan(new[] { Node(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-003.ipt") });
        h.ExistingSources.Add(plan.Nodes[0].SourceAbsolutePath);
        var confirmation = CopyDesignApplyConfirmationBuilder.Build(plan, _ => false);

        var result = await h.Build().ExecuteAsync(plan, "fresh-key", null, default, confirmation.Fingerprint);

        Assert.True(confirmation.CanApply);
        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
        Assert.Equal("ARCH-TEST-003", Assert.Single(h.Reservation.Calls).WireEntries.Single().Copy!.NewDocumentNumber);
    }

    [Fact]
    public async Task A_plan_that_changed_after_confirmation_is_refused_before_any_reservation_or_copy()
    {
        var h = new OrchestratorHarness();
        var confirmed = Plan(new[] { Node(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-003.ipt") });
        var changed = Plan(new[] { Node(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-004.ipt") });
        h.ExistingSources.Add(changed.Nodes[0].SourceAbsolutePath);
        var confirmation = CopyDesignApplyConfirmationBuilder.Build(confirmed, _ => false);

        var result = await h.Build().ExecuteAsync(changed, "fresh-key", null, default, confirmation.Fingerprint);

        Assert.Equal(CopyDesignApplyOutcome.MappingFailed, result.Outcome);
        Assert.Contains("changed after it was confirmed", result.FailureReason, StringComparison.Ordinal);
        Assert.Empty(h.Reservation.Calls);
        Assert.Empty(h.Copier.Calls);
        Assert.Empty(h.Materializer.Calls);
    }

    [Fact]
    public async Task A_stale_fingerprint_from_a_different_source_version_is_refused()
    {
        var h = new OrchestratorHarness();
        var confirmed = Plan(new[] { Node(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-003.ipt") });
        var newerSource = Plan(new[] { Node(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-003.ipt") with { CurrentFileVersionId = "fv-2" } });
        h.ExistingSources.Add(newerSource.Nodes[0].SourceAbsolutePath);

        var result = await h.Build().ExecuteAsync(
            newerSource, "fresh-key", null, default, CopyDesignApplyConfirmationBuilder.Build(confirmed, _ => false).Fingerprint);

        Assert.Equal(CopyDesignApplyOutcome.MappingFailed, result.Outcome);
        Assert.Empty(h.Reservation.Calls);
    }

    [Fact]
    public async Task Resume_and_Recover_style_calls_without_a_fingerprint_are_unchanged()
    {
        var h = new OrchestratorHarness();
        var plan = Plan(new[] { Node(@"D:\ArchPLM-Test\CopyPreview\ARCH-TEST-003.ipt") });
        h.ExistingSources.Add(plan.Nodes[0].SourceAbsolutePath);

        var result = await h.Build().ExecuteAsync(plan, "same-key", null);

        Assert.Equal(CopyDesignApplyOutcome.Succeeded, result.Outcome);
    }
}
