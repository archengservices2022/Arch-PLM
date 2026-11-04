namespace Arch.CadConnect.Core.CopyDesign;

/// <summary>P6 Milestone 2: how serious one plan message is.</summary>
public enum CopyDesignIssueSeverity
{
    /// <summary>Explains a safe decision (e.g. "Selected root") - never blocks.</summary>
    Info,

    /// <summary>Worth the engineer's attention, but does not by itself block
    ///  an executable plan (e.g. MODEL FILES ONLY mode).</summary>
    Warning,

    /// <summary>A reason the plan cannot be applied.</summary>
    Blocking,
}

/// <summary>ONE classified plan message. <see cref="SourceFileName"/> is the
///  node it belongs to, or <c>null</c> for a plan-level message.</summary>
public sealed record CopyDesignPlanIssue(CopyDesignIssueSeverity Severity, string? SourceFileName, string Message);

/// <summary>
/// P6 Milestone 2: classifies EVERY node reason and plan warning, so the
/// Preview report and the Apply confirmation show all of them - not merely a
/// node's first reason (which, for the live ARCH-TEST-001 root, was the
/// informational "Selected root..." text while the actual blocking reason was
/// hidden). PURE.
///
/// Rules (fail-safe - anything unrecognized on a blocked node is BLOCKING):
///  - a node whose action is <see cref="CopyDesignAction.NeedsDecision"/>:
///    every reason is Blocking, EXCEPT the planner's own informational
///    "why this action was chosen" texts (<see cref="InformationalReasonPrefixes"/>),
///    which stay Info;
///  - any other node (Copy / Reuse / Exclude): every reason is Info;
///  - a plan-level warning is Blocking when the plan is NOT executable (it is
///    one of the reasons it cannot run) and a Warning otherwise; the explicit
///    MODEL FILES ONLY acknowledgement is always a Warning;
///  - a non-executable plan that would otherwise show NO Blocking issue gets
///    one generic Blocking issue, so "not executable" is never unexplained.
/// </summary>
public static class CopyDesignPlanIssues
{
    /// <summary>The planner's informational reason texts (see
    ///  <see cref="CopyDesignPlanner"/>) - they explain how an action was
    ///  chosen, never why a node is blocked.</summary>
    public static readonly IReadOnlyList<string> InformationalReasonPrefixes = new[]
    {
        "Selected root of the Copy Design operation.",
        "Classified as a standard/library/shared component",
        "Classified as project-specific",
        "Explicit engineer decision:",
        "Associated drawing - proposed action mirrors its model",
    };

    private const string ModelFilesOnlyWarningPrefix = "MODE: MODEL FILES ONLY";

    public static CopyDesignIssueSeverity ClassifyNodeReason(CopyDesignNode node, string reason)
    {
        ArgumentNullException.ThrowIfNull(node);
        ArgumentNullException.ThrowIfNull(reason);
        if (node.ProposedAction != CopyDesignAction.NeedsDecision)
        {
            return CopyDesignIssueSeverity.Info;
        }
        return InformationalReasonPrefixes.Any(p => reason.StartsWith(p, StringComparison.Ordinal))
            ? CopyDesignIssueSeverity.Info
            : CopyDesignIssueSeverity.Blocking;
    }

    public static CopyDesignIssueSeverity ClassifyPlanWarning(CopyDesignPlan plan, string warning)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(warning);
        if (warning.StartsWith(ModelFilesOnlyWarningPrefix, StringComparison.Ordinal))
        {
            return CopyDesignIssueSeverity.Warning;
        }
        return plan.IsExecutable ? CopyDesignIssueSeverity.Warning : CopyDesignIssueSeverity.Blocking;
    }

    /// <summary>Every classified message, plan-level first, then per node in
    ///  plan order.</summary>
    public static IReadOnlyList<CopyDesignPlanIssue> Collect(CopyDesignPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var issues = new List<CopyDesignPlanIssue>();
        foreach (var warning in plan.Warnings)
        {
            issues.Add(new CopyDesignPlanIssue(ClassifyPlanWarning(plan, warning), null, warning));
        }
        foreach (var node in plan.Nodes)
        {
            foreach (var reason in node.Reasons)
            {
                issues.Add(new CopyDesignPlanIssue(ClassifyNodeReason(node, reason), node.SourceFileName, reason));
            }
        }
        if (!plan.IsExecutable && !issues.Any(i => i.Severity == CopyDesignIssueSeverity.Blocking))
        {
            issues.Insert(0, new CopyDesignPlanIssue(CopyDesignIssueSeverity.Blocking, null,
                "The plan is not executable."));
        }
        return issues;
    }

    public static string Label(CopyDesignIssueSeverity severity) => severity switch
    {
        CopyDesignIssueSeverity.Blocking => "BLOCKING",
        CopyDesignIssueSeverity.Warning => "WARNING",
        _ => "INFO",
    };
}
