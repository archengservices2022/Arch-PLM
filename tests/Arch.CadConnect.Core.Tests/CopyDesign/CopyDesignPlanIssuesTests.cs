using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.References;

using static Arch.CadConnect.Core.Tests.CopyDesign.CopyDesignFixtures;

namespace Arch.CadConnect.Core.Tests.CopyDesign;

/// <summary>
/// P6 Milestone 2: the Preview report shows EVERY reason with its severity
/// (Info / Warning / Blocking) - never only <c>node.Reasons[0]</c>, which for
/// the live unmatched-rename Preview was the informational "Selected root"
/// text while the real blocking reason stayed hidden.
/// </summary>
public class CopyDesignPlanIssuesTests
{
    private const string Source001 = @"D:\ArchPLM-Test\GetLatest\ARCH-TEST-001.ipt";

    private sealed class AlwaysFoundEmpty : IDrawingAssociationSource
    {
        public static readonly AlwaysFoundEmpty Instance = new();
        public DrawingAssociationResult GetAssociatedDrawings(string cadDocumentId) =>
            new(DrawingAssociationOutcome.Found, Array.Empty<AssociatedDrawing>());
    }

    private static CopyDesignPlan LivePlan(string find, string replace) =>
        CopyDesignPlanner.Plan(
            Scan(Root(Source001, "cad_root", "fv_root1", CadDocumentType.Ipt), Array.Empty<CadReference>()),
            new TokenReplaceNameRule(find, replace), @"D:\ArchPLM-Test\CopyPreview", drawingSource: AlwaysFoundEmpty.Instance);

    [Fact]
    public void The_live_unmatched_rename_Preview_now_shows_the_blocking_reason_not_just_the_first_reason()
    {
        var text = CopyDesignPlanTextReport.Render(LivePlan("arch-test-001", "ARCH-TEST-003"));

        Assert.Contains("Plan status: NOT EXECUTABLE", text, StringComparison.Ordinal);
        Assert.Contains("BLOCKED (1 reason below)", text, StringComparison.Ordinal);
        Assert.Contains("Blocking errors (must be resolved before Apply):", text, StringComparison.Ordinal);
        Assert.Contains("[BLOCKING] ARCH-TEST-001.ipt: " + CopyDesignPlanner.UnmatchedRenameRuleReasonPrefix, text, StringComparison.Ordinal);
        Assert.Contains("[INFO] ARCH-TEST-001.ipt: Selected root of the Copy Design operation.", text, StringComparison.Ordinal);
    }

    [Fact]
    public void The_live_matching_rename_Preview_is_READY_with_the_exact_mapping_and_no_blocking_section()
    {
        var plan = LivePlan("ARCH-TEST-001", "ARCH-TEST-003");
        var text = CopyDesignPlanTextReport.Render(plan);

        Assert.True(plan.IsExecutable);
        Assert.Contains("READY", text, StringComparison.Ordinal);
        Assert.Contains("ARCH-TEST-003.ipt", text, StringComparison.Ordinal);
        Assert.DoesNotContain("Blocking errors", text, StringComparison.Ordinal);
        Assert.Contains(" OK", text, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_reason_of_a_blocked_node_is_classified_and_informational_prefixes_stay_info()
    {
        var node = new CopyDesignNode("cad-1", "fv-1", CadDocumentType.Ipt, @"C:\a.ipt", "a.ipt", null, true, true, true,
            CopyDesignAction.NeedsDecision, null, null,
            new[] { "Selected root of the Copy Design operation.", "Something unsafe.", "Something else unsafe." }, IsRoot: true);

        Assert.Equal(CopyDesignIssueSeverity.Info, CopyDesignPlanIssues.ClassifyNodeReason(node, node.Reasons[0]));
        Assert.Equal(CopyDesignIssueSeverity.Blocking, CopyDesignPlanIssues.ClassifyNodeReason(node, node.Reasons[1]));
        Assert.Equal(CopyDesignIssueSeverity.Blocking, CopyDesignPlanIssues.ClassifyNodeReason(node, node.Reasons[2]));

        var copyNode = node with { ProposedAction = CopyDesignAction.Copy };
        Assert.All(copyNode.Reasons, r => Assert.Equal(CopyDesignIssueSeverity.Info, CopyDesignPlanIssues.ClassifyNodeReason(copyNode, r)));
    }

    [Fact]
    public void Plan_warnings_are_blocking_only_when_the_plan_is_not_executable_and_MODEL_FILES_ONLY_is_always_a_warning()
    {
        var plan = CopyDesignPlan.Empty(Source001, "nothing") with
        {
            Warnings = new[] { "Some plan-level problem.", "MODE: MODEL FILES ONLY - drawings not included." },
            IsExecutable = true,
        };

        Assert.Equal(CopyDesignIssueSeverity.Warning, CopyDesignPlanIssues.ClassifyPlanWarning(plan, plan.Warnings[0]));
        var blocked = plan with { IsExecutable = false };
        Assert.Equal(CopyDesignIssueSeverity.Blocking, CopyDesignPlanIssues.ClassifyPlanWarning(blocked, blocked.Warnings[0]));
        Assert.Equal(CopyDesignIssueSeverity.Warning, CopyDesignPlanIssues.ClassifyPlanWarning(blocked, blocked.Warnings[1]));
    }

    [Fact]
    public void A_non_executable_plan_with_no_classified_blocker_still_gets_one_explicit_blocking_issue()
    {
        var plan = CopyDesignPlan.Empty(Source001, "x") with { Warnings = Array.Empty<string>(), IsExecutable = false };

        var issues = CopyDesignPlanIssues.Collect(plan);

        Assert.Contains(issues, i => i.Severity == CopyDesignIssueSeverity.Blocking && i.Message == "The plan is not executable.");
    }

    [Fact]
    public void The_planner_carries_the_source_document_number_from_the_manifest_identity()
    {
        var root = new CadReferenceRoot(Source001, CadDocumentType.Ipt, new PlmIdentity("cad_root", "ARCH-TEST-001.ipt", "fv_root1"), true);
        var plan = CopyDesignPlanner.Plan(Scan(root, Array.Empty<CadReference>()),
            new TokenReplaceNameRule("ARCH-TEST-001", "ARCH-TEST-003"), @"D:\ArchPLM-Test\CopyPreview", drawingSource: AlwaysFoundEmpty.Instance);

        Assert.Equal("ARCH-TEST-001.ipt", Assert.Single(plan.Nodes).SourceDocumentNumber);
    }
}
