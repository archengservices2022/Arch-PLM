using Arch.CadConnect.Core.CopyDesign;
using Arch.CadConnect.Core.CopyDesign.Apply;

namespace Arch.CadConnect.Core.Tests.CopyDesign.Apply;

/// <summary>
/// M4.1 T6 follow-up: the typed <c>APPLY N</c> phrase that unlocks Apply Copy
/// Design. Exact match only (leading/trailing whitespace aside), N = the
/// confirmation's COPY rows, and never satisfied for a confirmation that
/// cannot apply.
/// </summary>
public class CopyDesignApplyTypedConfirmationTests
{
    private static CopyDesignApplyConfirmationRow Row(CopyDesignApplyEntryAction action, string name) => new(
        action, CadDocumentType.Ipt, name + ".ipt", name,
        action == CopyDesignApplyEntryAction.Copy ? "NEW-" + name + ".ipt" : null,
        action == CopyDesignApplyEntryAction.Copy ? "NEW-" + name : null,
        action == CopyDesignApplyEntryAction.Copy ? @"C:\Dest" : null);

    private static CopyDesignApplyConfirmation Confirmation(int copies, int reuses = 0, bool canApply = true) => new(
        Rows: Enumerable.Range(0, copies).Select(i => Row(CopyDesignApplyEntryAction.Copy, "C" + i))
            .Concat(Enumerable.Range(0, reuses).Select(i => Row(CopyDesignApplyEntryAction.Reuse, "R" + i)))
            .ToArray(),
        Issues: Array.Empty<CopyDesignPlanIssue>(),
        DestinationFolders: new[] { @"C:\Dest" },
        ModelFilesOnly: false,
        Fingerprint: canApply ? "fp" : null,
        CanApply: canApply);

    [Theory]
    [InlineData(4, 0, "APPLY 4")]   // the T6 shape: root, two parts, drawing
    [InlineData(1, 0, "APPLY 1")]
    [InlineData(3, 2, "APPLY 3")]   // REUSE rows are neither copied nor materialized
    [InlineData(12, 0, "APPLY 12")]
    public void The_phrase_names_the_number_of_files_to_be_copied(int copies, int reuses, string expected)
    {
        Assert.Equal(expected, CopyDesignApplyTypedConfirmation.ExpectedPhrase(Confirmation(copies, reuses)));
    }

    [Theory]
    [InlineData("APPLY 4")]
    [InlineData("  APPLY 4")]
    [InlineData("APPLY 4   ")]
    [InlineData("\tAPPLY 4\r\n")]
    public void The_exact_phrase_is_accepted_ignoring_only_leading_and_trailing_whitespace(string typed)
    {
        Assert.True(CopyDesignApplyTypedConfirmation.IsSatisfied(Confirmation(4), typed));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("apply 4")]          // lowercase
    [InlineData("Apply 4")]
    [InlineData("APPLy 4")]
    [InlineData("APPLY")]            // partial
    [InlineData("APPLY ")]
    [InlineData("APP")]
    [InlineData("4")]
    [InlineData("APPLY 3")]          // wrong numbers
    [InlineData("APPLY 5")]
    [InlineData("APPLY 04")]
    [InlineData("APPLY 4.0")]
    [InlineData("APPLY +4")]
    [InlineData("APPLY  4")]         // inner whitespace is not ignored
    [InlineData("APPLY\t4")]
    [InlineData("APPLY4")]
    [InlineData("APPLY 4.")]         // extra text
    [InlineData("APPLY 4 files")]
    [InlineData("YES APPLY 4")]
    [InlineData("\"APPLY 4\"")]
    [InlineData("ＡＰＰＬＹ ４")]    // full-width look-alikes
    [InlineData("APPLY ٤")]          // non-ASCII digit
    [InlineData("APPLY\u00A04")]     // non-breaking space
    public void Any_other_text_does_not_enable_Apply(string? typed)
    {
        Assert.False(CopyDesignApplyTypedConfirmation.IsSatisfied(Confirmation(4), typed));
    }

    [Fact]
    public void A_confirmation_that_cannot_apply_is_never_satisfied_even_by_the_exact_phrase()
    {
        var blocked = Confirmation(4, canApply: false);

        Assert.False(CopyDesignApplyTypedConfirmation.IsSatisfied(blocked, CopyDesignApplyTypedConfirmation.ExpectedPhrase(blocked)));
    }

    [Fact]
    public void The_phrase_for_one_plan_does_not_unlock_a_plan_of_a_different_size()
    {
        var four = Confirmation(4);
        var three = Confirmation(3);

        Assert.False(CopyDesignApplyTypedConfirmation.IsSatisfied(three, CopyDesignApplyTypedConfirmation.ExpectedPhrase(four)));
        Assert.True(CopyDesignApplyTypedConfirmation.IsSatisfied(three, CopyDesignApplyTypedConfirmation.ExpectedPhrase(three)));
    }

    [Fact]
    public void Null_confirmations_are_rejected()
    {
        Assert.Throws<ArgumentNullException>(() => CopyDesignApplyTypedConfirmation.ExpectedPhrase(null!));
        Assert.Throws<ArgumentNullException>(() => CopyDesignApplyTypedConfirmation.IsSatisfied(null!, "APPLY 4"));
    }
}
